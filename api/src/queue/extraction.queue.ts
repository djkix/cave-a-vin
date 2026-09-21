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
