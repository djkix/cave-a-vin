import { PrismaService } from '../prisma/prisma.service';

/**
 * Demandes d'accords et de descriptifs : une ligne PENDING suffit, le lot
 * suivant du worker la prend (voir generation-batch.processor.ts). Créées
 * seulement si elles manquent (`skipDuplicates`, sans course possible entre
 * deux créations) : une demande existante, en attente ou déjà servie, n'est
 * pas touchée. Aucun appel à Gemini, aucune file Redis.
 */
export async function requestPairings(prisma: Pick<PrismaService, 'pairing'>, wineIds: string[], now = new Date()): Promise<number> {
  if (wineIds.length === 0) return 0;
  const { count } = await prisma.pairing.createMany({ data: wineIds.map((wineId) => ({ wineId, requestedAt: now })), skipDuplicates: true });
  return count;
}

export async function requestProducerProfiles(
  prisma: Pick<PrismaService, 'producerProfile'>,
  producers: Array<{ producerKey: string; displayName: string }>,
  now = new Date(),
): Promise<number> {
  if (producers.length === 0) return 0;
  const { count } = await prisma.producerProfile.createMany({ data: producers.map((p) => ({ ...p, requestedAt: now })), skipDuplicates: true });
  return count;
}
