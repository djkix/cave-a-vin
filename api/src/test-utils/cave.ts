import { Cave, Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Cave de test pour les essais d'intégration : vins, photos, exports et
 * recherches d'image exigent désormais une cave. Avec `owner`, le compte reçoit
 * aussi sa ligne OWNER, comme une vraie cave.
 */
export async function createTestCave(prisma: PrismaClient, opts: { owner?: { id: string }; name?: string } = {}): Promise<Cave> {
  return prisma.cave.create({
    data: {
      name: opts.name ?? `Cave d'essai ${randomUUID().slice(0, 8)}`,
      ownerId: opts.owner?.id ?? null,
      ...(opts.owner ? { members: { create: { userId: opts.owner.id, role: 'OWNER' as const } } } : {}),
    },
  });
}

/**
 * Supprime les caves de test restées vides (leurs membres suivent). Une cave qui
 * contient encore des lignes est gardée sans erreur : les suites tournent en
 * parallèle sur la même base, et pendant la transition une route peut écrire
 * dans la plus ancienne cave, qui peut être une cave de test sur une base neuve.
 */
export async function deleteTestCaves(prisma: PrismaClient, ids: string[]): Promise<void> {
  try {
    await prisma.cave.deleteMany({
      where: { id: { in: ids }, wines: { none: {} }, photos: { none: {} }, exportLogs: { none: {} }, imageSearchCosts: { none: {} } },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003')) throw e;
  }
}
