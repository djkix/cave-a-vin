import { PrismaService } from '../prisma/prisma.service';
import { producerKeyOf } from './producer-key';

export interface ProducerWine {
  producer: string;
  appellationRaw: string;
  appellation: { canonicalName: string; region: string | null } | null;
}

/**
 * Vins d'un domaine, du plus ancien au plus récent. La clé (sans accents ni
 * ponctuation) ne se calcule pas en SQL à l'identique : la cave compte quelques
 * centaines de vins, on filtre donc en mémoire.
 */
export async function findProducerWines(prisma: Pick<PrismaService, 'wine'>, key: string): Promise<ProducerWine[]> {
  if (!key) return [];
  const wines = await prisma.wine.findMany({
    select: { producer: true, appellationRaw: true, appellation: { select: { canonicalName: true, region: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return wines.filter((w) => producerKeyOf(w.producer) === key);
}

/** Vins de plusieurs domaines en une seule lecture (lot de descriptifs), du plus ancien au plus récent. */
export async function findWinesByProducer(prisma: Pick<PrismaService, 'wine'>, keys: string[]): Promise<Map<string, ProducerWine[]>> {
  const byKey = new Map<string, ProducerWine[]>(keys.filter(Boolean).map((k) => [k, []]));
  if (byKey.size === 0) return byKey;
  const wines = await prisma.wine.findMany({
    select: { producer: true, appellationRaw: true, appellation: { select: { canonicalName: true, region: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const w of wines) byKey.get(producerKeyOf(w.producer))?.push(w);
  return byKey;
}
