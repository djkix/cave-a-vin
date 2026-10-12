/**
 * File BullMQ des versions précédentes : accords ('pairing') et descriptifs
 * ('producer') y étaient mis un par un. Elle n'est plus alimentée — les tables
 * `pairing` et `producer_profile` servent désormais de file (voir
 * generation-batch.processor.ts) — mais le worker la vide encore : les
 * travaux restés en attente dans Redis à la mise à jour ne font que remettre
 * leur demande en attente en base (voir legacy-pairing-job.ts).
 */
export const PAIRING_QUEUE = 'wine-pairing';

export interface PairingJobData {
  wineId: string;
}

export interface ProducerJobData {
  producerKey: string;
}

export type WinePairingJobData = PairingJobData | ProducerJobData;

/** Nom des travaux de descriptif dans l'ancienne file. */
export const PRODUCER_JOB = 'producer';
