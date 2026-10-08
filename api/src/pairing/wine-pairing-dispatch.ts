import { DelayedError, Job } from 'bullmq';
import { PRODUCER_JOB } from '../producers/producer.queue';
import { GeminiPausedError } from '../vision/gemini-pause';
import { PairingJobData, ProducerJobData, WinePairingJobData } from './pairing.queue';

export interface WinePairingProcessors {
  pairing: { process(wineId: string, isLastAttempt: boolean): Promise<void> };
  producer: { process(producerKey: string, isLastAttempt: boolean): Promise<void> };
}

type WinePairingJob = Pick<Job<WinePairingJobData>, 'name' | 'data' | 'attemptsMade' | 'opts' | 'moveToDelayed'>;

/** Écart ajouté après la fin d'une pause : les travaux reportés ne repartent pas tous à la même milliseconde. */
export const PAUSE_JITTER_MS = 5000;

/**
 * La file `wine-pairing` porte deux sortes de travaux : on aiguille par leur nom.
 *
 * Pause commune de Gemini : le travail est remis en attente jusqu'à la fin de
 * la pause (plus quelques secondes) par `job.moveToDelayed`, puis `DelayedError`
 * dit au worker BullMQ de ne pas le traiter comme un échec. `moveToDelayed`
 * n'incrémente pas `attemptsMade` (skipAttempt, BullMQ 5) : aucune tentative
 * consommée.
 */
export async function processWinePairingJob(job: WinePairingJob, processors: WinePairingProcessors, token?: string): Promise<void> {
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  try {
    if (job.name === PRODUCER_JOB) return await processors.producer.process((job.data as ProducerJobData).producerKey, isLastAttempt);
    return await processors.pairing.process((job.data as PairingJobData).wineId, isLastAttempt);
  } catch (e) {
    if (!(e instanceof GeminiPausedError)) throw e;
    await job.moveToDelayed(e.until.getTime() + Math.floor(Math.random() * PAUSE_JITTER_MS), token);
    throw new DelayedError(e.message);
  }
}
