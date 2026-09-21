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

/** Nom de la stratégie de report, câblée sur le Worker (voir worker.ts). */
export const EXTRACTION_BACKOFF = 'reprise-differee';

/**
 * Une indisponibilité passagère ne doit jamais faire perdre une photo : le worker
 * réessaie donc pendant des jours plutôt que pendant six secondes. Au plafond de
 * quinze minutes, mille tentatives couvrent environ dix jours de panne continue —
 * assez pour un incident fournisseur, une coupure de liaison ou un serveur éteint
 * le temps d'un week-end. Au-delà, la photo passe en échec et reste saisissable à
 * la main : BullMQ a besoin d'un nombre fini, et un travail qui ne meurt jamais
 * finirait par masquer une panne réelle.
 */
export const EXTRACTION_ATTEMPTS = 1000;

const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

/**
 * 30 s, 1 min, 2, 4, 8, puis 15 min à chaque tentative suivante. Le premier délai
 * est volontairement bien plus long que l'ancien (2 s) : une saturation de modèle
 * dure des minutes, et trois tentatives rapprochées tombaient toutes dans la même
 * vague de congestion. Le plafond évite de marteler l'API pendant une panne longue.
 */
export function extractionBackoffDelay(attemptsMade: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** Math.max(0, attemptsMade - 1), MAX_DELAY_MS);
}

export function createExtractionQueue(): Queue<ExtractionJobData> {
  return new Queue<ExtractionJobData>(EXTRACTION_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: EXTRACTION_ATTEMPTS,
      backoff: { type: EXTRACTION_BACKOFF },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
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
