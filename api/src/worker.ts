import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { PairingProcessor } from './pairing/pairing.processor';
import { requeueMissingPairings } from './pairing/pairing-recovery';
import { PAIRING_QUEUE, PAIRING_QUEUE_TOKEN, PairingJobData } from './pairing/pairing.queue';
import { PrismaService } from './prisma/prisma.service';
import { ENTRY_BATCH_TICK_MS, createEntryBatchLoop } from './queue/entry-batch';
import { EntryBatchProcessor } from './queue/entry-batch.processor';
import { ExtractionProcessor } from './queue/extraction.processor';
import { EXTRACTION_QUEUE, ExtractionJobData, extractionBackoffDelay, redisConnection } from './queue/extraction.queue';
import { requeueOrphanPhotos } from './queue/orphan-recovery';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const processor = app.get(ExtractionProcessor);
  const worker = new Worker<ExtractionJobData>(
    EXTRACTION_QUEUE,
    (job) => processor.process(job.data.photoId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
    {
      connection: redisConnection(),
      concurrency: 5,
      // Les délais de reprise sont calculés ici, pas dans les options du travail :
      // BullMQ résout une stratégie nommée côté worker, ce qui permet d'allonger
      // la patience sans toucher aux travaux déjà en file.
      settings: { backoffStrategy: (attemptsMade: number) => extractionBackoffDelay(attemptsMade) },
    },
  );
  worker.on('failed', (job, err) => console.warn(`job ${job?.id} failed: ${err.message}`));
  worker.on('error', (err) => console.error(`worker : ${err.message}`));
  console.log('worker prêt (photo-extraction, concurrence 5)');

  const pairingProcessor = app.get(PairingProcessor);
  const pairingWorker = new Worker<PairingJobData>(
    PAIRING_QUEUE,
    (job) => pairingProcessor.process(job.data.wineId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
    {
      connection: redisConnection(),
      concurrency: 1,
      settings: { backoffStrategy: (attemptsMade: number) => extractionBackoffDelay(attemptsMade) },
    },
  );
  pairingWorker.on('failed', (job, err) => console.warn(`accords ${job?.id} : ${err.message}`));
  pairingWorker.on('error', (err) => console.error(`worker accords : ${err.message}`));
  console.log('worker prêt (wine-pairing, concurrence 1)');

  // Avant de traiter la file, rattraper les photos que Redis a oubliées : sans
  // cela, un simple redémarrage suffit à laisser une photo stockée sur le disque
  // sans personne pour l'analyser.
  try {
    await requeueOrphanPhotos(app.get(PrismaService), (m) => console.log(m));
  } catch (e) {
    console.error(`reprise au démarrage impossible : ${(e as Error).message}`);
  }
  try {
    await requeueMissingPairings(app.get(PrismaService), app.get(PAIRING_QUEUE_TOKEN), (m) => console.log(m));
  } catch (e) {
    console.error(`rattrapage des accords impossible : ${(e as Error).message}`);
  }
  // Photos d'entrée : pas de travail BullMQ, la table photo sert de file. Un
  // passage au démarrage reprend aussi les réservations échues d'un arrêt brutal.
  const entryBatchLoop = createEntryBatchLoop(
    () => app.get(EntryBatchProcessor).tick(),
    ENTRY_BATCH_TICK_MS,
    (e) => console.error(`lot d'entrée : ${(e as Error).message}`),
  );
  entryBatchLoop.start();
  console.log(`worker prêt (photos d'entrée par lots, toutes les ${ENTRY_BATCH_TICK_MS / 1000} s)`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await entryBatchLoop.stop();
    await pairingWorker.close();
    await worker.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
