import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EXTRACTION_ATTEMPTS, EXTRACTION_BACKOFF, redisConnection } from '../queue/extraction.queue';

export const PAIRING_QUEUE = 'wine-pairing';
export const PAIRING_QUEUE_TOKEN = 'PAIRING_QUEUE';

export interface PairingJobData {
  wineId: string;
}

/** Un identifiant par vin : jamais deux générations du même vin dans la file. */
export const pairingJobId = (wineId: string) => `pairing-${wineId}`;

/** Même patience que les photos : une panne de Gemini ne perd jamais un vin. */
export function createPairingQueue(): Queue<PairingJobData> {
  return new Queue<PairingJobData>(PAIRING_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: EXTRACTION_ATTEMPTS, backoff: { type: EXTRACTION_BACKOFF }, removeOnComplete: 1000, removeOnFail: 1000 },
  });
}

export type PairingQueueLike = Pick<Queue<PairingJobData>, 'add' | 'getJob'>;

/**
 * BullMQ ignore un `add` dont l'identifiant existe encore, y compris parmi les
 * travaux terminés gardés en mémoire : pour régénérer, on retire d'abord un
 * travail terminé ou échoué ; un travail encore vivant est laissé tel quel.
 */
export async function schedulePairing(queue: PairingQueueLike, wineId: string): Promise<void> {
  const id = pairingJobId(wineId);
  const job = await queue.getJob(id);
  if (job) {
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed') return;
    // Deux régénérations quasi simultanées voient toutes deux le travail terminé :
    // le second retrait échoue (déjà retiré). On poursuit : `add` remet le vin en
    // file, ou ne fait rien si l'autre demande l'a déjà fait.
    await job.remove().catch(() => undefined);
  }
  await queue.add('pairing', { wineId }, { jobId: id });
}

/** Voir `closeQueue` (extraction.queue.ts) : la connexion fournie doit être quittée à la main. */
export async function closePairingQueue(queue: Queue<PairingJobData>): Promise<void> {
  const { connection } = queue.opts;
  await queue.close();
  if (connection instanceof Redis) await connection.quit();
}
