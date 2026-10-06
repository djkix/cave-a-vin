import { PairingQueueLike } from '../pairing/pairing.queue';
import { producerKeyOf } from './producer-key';
import { scheduleProducer } from './producer.queue';

export interface ProducerRecoveryPrisma {
  wine: { findMany(args: unknown): Promise<{ producer: string }[]> };
  producerProfile: { findMany(args: unknown): Promise<{ producerKey: string; status: string }[]> };
}

/**
 * Au démarrage du worker : chaque domaine des vins en cave sans descriptif, ou
 * dont la génération est restée en attente, est (re)mis en file, une seule fois
 * même si plusieurs graphies du nom coexistent. Idempotent.
 */
export async function requeueMissingProducers(
  prisma: ProducerRecoveryPrisma,
  queue: PairingQueueLike,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const [wines, profiles] = await Promise.all([
    prisma.wine.findMany({ select: { producer: true }, distinct: ['producer'] }),
    prisma.producerProfile.findMany({ select: { producerKey: true, status: true } }),
  ]);
  const statusOf = new Map(profiles.map((p) => [p.producerKey, p.status]));
  const keys = new Set<string>();
  for (const w of wines) {
    const key = producerKeyOf(w.producer);
    const status = statusOf.get(key);
    if (key && (status === undefined || status === 'PENDING')) keys.add(key);
  }
  for (const key of keys) await scheduleProducer(queue, key);
  if (keys.size) log(`descriptifs : ${keys.size} domaine(s) mis en file`);
  return keys.size;
}
