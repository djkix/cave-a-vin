import { Job } from 'bullmq';
import { PRODUCER_JOB } from '../producers/producer.queue';
import { PairingJobData, ProducerJobData, WinePairingJobData } from './pairing.queue';

export interface WinePairingProcessors {
  pairing: { process(wineId: string, isLastAttempt: boolean): Promise<void> };
  producer: { process(producerKey: string, isLastAttempt: boolean): Promise<void> };
}

type WinePairingJob = Pick<Job<WinePairingJobData>, 'name' | 'data' | 'attemptsMade' | 'opts'>;

/** La file `wine-pairing` porte deux sortes de travaux : on aiguille par leur nom. */
export function processWinePairingJob(job: WinePairingJob, processors: WinePairingProcessors): Promise<void> {
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (job.name === PRODUCER_JOB) return processors.producer.process((job.data as ProducerJobData).producerKey, isLastAttempt);
  return processors.pairing.process((job.data as PairingJobData).wineId, isLastAttempt);
}
