import { PairingQueueLike, schedulePairing } from './pairing.queue';

export interface PairingRecoveryPrisma {
  wine: { findMany(args: unknown): Promise<{ id: string }[]> };
}

/**
 * Au démarrage du worker : tout vin sans accords, ou dont la génération est
 * restée en attente, est (re)mis en file. Couvre les vins existants à la mise à
 * jour et les travaux qu'un Redis vidé aurait oubliés. Idempotent.
 */
export async function requeueMissingPairings(
  prisma: PairingRecoveryPrisma,
  queue: PairingQueueLike,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const wines = await prisma.wine.findMany({
    where: { OR: [{ pairing: null }, { pairing: { status: 'PENDING' } }] },
    select: { id: true },
  });
  for (const w of wines) await schedulePairing(queue, w.id);
  if (wines.length) log(`accords : ${wines.length} vin(s) mis en file`);
  return wines.length;
}
