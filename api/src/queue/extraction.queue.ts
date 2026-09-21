import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadEnv } from '../config/env';

export const EXTRACTION_QUEUE = 'photo-extraction';
export const EXTRACTION_QUEUE_TOKEN = 'EXTRACTION_QUEUE';

export interface ExtractionJobData {
  photoId: string;
}

export function redisConnection(): Redis {
  return new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

export function createExtractionQueue(): Queue<ExtractionJobData> {
  return new Queue<ExtractionJobData>(EXTRACTION_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 1000 },
  });
}

/**
 * BullMQ traite une connexion qu'on lui fournit comme « partagée » et ne la ferme
 * jamais : il faut la quitter soi-même, sinon le process (api arrêtée, suite Jest)
 * garde une socket Redis ouverte et ne rend jamais la main. `Queue` conserve
 * l'instance telle quelle dans ses options ; `QueueEvents`, lui, la duplique et
 * ferme la copie — il doit donc quitter son instance d'origine lui-même
 * (voir PhotoEventsController).
 */
export async function closeQueue(queue: Queue<ExtractionJobData>): Promise<void> {
  const { connection } = queue.opts;
  await queue.close();
  if (connection instanceof Redis) await connection.quit();
}
