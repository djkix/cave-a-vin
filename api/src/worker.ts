import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { GENERATION_BATCH_TICK_MS } from './pairing/generation-batch';
import { handleLegacyPairingJob } from './pairing/legacy-pairing-job';
import { PairingBatchProcessor } from './pairing/pairing-batch.processor';
import { requeueMissingPairings } from './pairing/pairing-recovery';
import { PAIRING_QUEUE, PRODUCER_JOB, WinePairingJobData } from './pairing/pairing.queue';
import { PrismaService } from './prisma/prisma.service';
import { ProducerBatchProcessor } from './producers/producer-batch.processor';
import { requeueMissingProducers } from './producers/producer-recovery';
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

  // Ancienne file des accords et descriptifs, un élément par travail : plus
  // alimentée, mais vidée. Un travail resté dans Redis à la mise à jour ne fait
  // que remettre sa demande en attente en base, sans appel à Gemini ; le lot
  // suivant s'en charge (voir legacy-pairing-job.ts).
  const prisma = app.get(PrismaService);
  const legacyPairingWorker = new Worker<WinePairingJobData>(PAIRING_QUEUE, (job) => handleLegacyPairingJob(prisma, job), {
    connection: redisConnection(),
    concurrency: 1,
    settings: { backoffStrategy: (attemptsMade: number) => extractionBackoffDelay(attemptsMade) },
  });
  legacyPairingWorker.on('failed', (job, err) => console.warn(`ancien travail ${job?.name === PRODUCER_JOB ? 'de descriptif' : "d'accords"} ${job?.id} : ${err.message}`));
  legacyPairingWorker.on('error', (err) => console.error(`ancienne file des accords : ${err.message}`));

  // Avant de traiter la file, rattraper les photos que Redis a oubliées : sans
  // cela, un simple redémarrage suffit à laisser une photo stockée sur le disque
  // sans personne pour l'analyser.
  try {
    await requeueOrphanPhotos(prisma, (m) => console.log(m));
  } catch (e) {
    console.error(`reprise au démarrage impossible : ${(e as Error).message}`);
  }
  try {
    await requeueMissingPairings(prisma, (m) => console.log(m));
  } catch (e) {
    console.error(`rattrapage des accords impossible : ${(e as Error).message}`);
  }
  try {
    await requeueMissingProducers(prisma, (m) => console.log(m));
  } catch (e) {
    console.error(`rattrapage des descriptifs de domaine impossible : ${(e as Error).message}`);
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

  // Accords et descriptifs de domaine : même principe, les tables `pairing` et
  // `producer_profile` servent de file, dix demandes au plus par appel Gemini.
  const pairingLoop = createEntryBatchLoop(
    () => app.get(PairingBatchProcessor).tick(),
    GENERATION_BATCH_TICK_MS,
    (e) => console.error(`lot d'accords : ${(e as Error).message}`),
  );
  const producerLoop = createEntryBatchLoop(
    () => app.get(ProducerBatchProcessor).tick(),
    GENERATION_BATCH_TICK_MS,
    (e) => console.error(`lot de descriptifs : ${(e as Error).message}`),
  );
  pairingLoop.start();
  producerLoop.start();
  console.log(`worker prêt (accords et descriptifs par lots de dix, toutes les ${GENERATION_BATCH_TICK_MS / 1000} s)`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([entryBatchLoop.stop(), pairingLoop.stop(), producerLoop.stop()]);
    await legacyPairingWorker.close();
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
