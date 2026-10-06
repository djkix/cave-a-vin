import { Prisma } from '@prisma/client';

/**
 * Deux créations simultanées du même profil (saisie manuelle contre worker) :
 * l'upsert perdant lève P2002. La ligne existe alors ; le rejouer une fois
 * suffit à passer par la mise à jour.
 */
export async function retryOnceOnUniqueConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return fn();
    throw e;
  }
}
