import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { ExtractionProcessor } from './queue/extraction.processor';
import { EXTRACTION_QUEUE, ExtractionJobData, redisConnection } from './queue/extraction.queue';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const processor = app.get(ExtractionProcessor);
  const worker = new Worker<ExtractionJobData>(EXTRACTION_QUEUE, (job) => processor.process(job.data.photoId), {
    connection: redisConnection(),
    concurrency: 5,
  });
  worker.on('failed', (job, err) => console.warn(`job ${job?.id} failed: ${err.message}`));
  console.log('worker prêt (photo-extraction, concurrence 5)');
  const stop = async () => { await worker.close(); await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
