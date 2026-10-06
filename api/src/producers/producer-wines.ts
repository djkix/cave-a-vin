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
