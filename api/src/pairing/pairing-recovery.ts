import { PrismaService } from '../prisma/prisma.service';
import { requestPairings } from './generation-requests';

/**
 * Au démarrage du worker : tout vin sans demande d'accords en reçoit une, en
 * attente (vins créés quand l'écriture de la demande a échoué, vins d'avant
 * les accords). Les demandes déjà en attente sont dans la file : rien à
 * faire pour elles. Idempotent, sans appel à Gemini.
 */
export async function requeueMissingPairings(
  prisma: Pick<PrismaService, 'wine' | 'pairing'>,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const wines = await prisma.wine.findMany({ where: { pairing: null }, select: { id: true } });
  const created = await requestPairings(prisma, wines.map((w) => w.id));
  if (created) log(`accords : ${created} vin(s) mis en attente`);
  return created;
}
