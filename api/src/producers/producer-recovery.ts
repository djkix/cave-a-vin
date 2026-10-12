import { requestProducerProfiles } from '../pairing/generation-requests';
import { PrismaService } from '../prisma/prisma.service';
import { producerKeyOf } from './producer-key';

/**
 * Au démarrage du worker : chaque domaine des vins en cave sans descriptif en
 * reçoit un, en attente, une seule fois même si plusieurs graphies du nom
 * coexistent (nom affiché : celui du vin le plus ancien). Les descriptifs déjà
 * en attente sont dans la file : rien à faire pour eux. Idempotent, sans appel
 * à Gemini.
 */
export async function requeueMissingProducers(
  prisma: Pick<PrismaService, 'wine' | 'producerProfile'>,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const [wines, profiles] = await Promise.all([
    prisma.wine.findMany({ select: { producer: true }, orderBy: { createdAt: 'asc' } }),
    prisma.producerProfile.findMany({ select: { producerKey: true } }),
  ]);
  const known = new Set(profiles.map((p) => p.producerKey));
  const missing = new Map<string, string>();
  for (const w of wines) {
    const key = producerKeyOf(w.producer);
    if (key && !known.has(key) && !missing.has(key)) missing.set(key, w.producer);
  }
  const created = await requestProducerProfiles(prisma, [...missing].map(([producerKey, displayName]) => ({ producerKey, displayName })));
  if (created) log(`descriptifs : ${created} domaine(s) mis en attente`);
  return created;
}
