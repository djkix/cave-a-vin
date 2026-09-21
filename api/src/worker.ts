import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { ExtractionProcessor } from './queue/extraction.processor';
import {
  EXTRACTION_QUEUE,
  EXTRACTION_QUEUE_TOKEN,
  ExtractionJobData,
  extractionBackoffDelay,
  redisConnection,
} from './queue/extraction.queue';
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

  // Avant de traiter la file, rattraper les photos que Redis a oubliées : sans
  // cela, un simple redémarrage suffit à laisser une photo stockée sur le disque
  // sans personne pour l'analyser.
  try {
    await requeueOrphanPhotos(app.get(PrismaService), app.get(EXTRACTION_QUEUE_TOKEN), (m) => console.log(m));
  } catch (e) {
    console.error(`reprise au démarrage impossible : ${(e as Error).message}`);
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
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
