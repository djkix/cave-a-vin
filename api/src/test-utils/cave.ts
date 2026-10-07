import { Cave, PrismaClient } from '@prisma/client';
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
 * Supprime les caves de test et tout ce qu'elles contiennent (mouvements,
 * accords, vins, photos, exports, coûts de recherche d'image ; les membres
 * suivent par cascade). Chaque route écrit dans la cave courante de son compte :
 * une cave créée par une suite ne reçoit que les lignes de cette suite, qu'on
 * peut donc effacer sans toucher aux suites qui tournent en parallèle.
 */
export async function deleteTestCaves(prisma: PrismaClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const inCaves = { caveId: { in: ids } };
  await prisma.$transaction([
    prisma.movement.deleteMany({ where: { OR: [{ wine: inCaves }, { photo: inCaves }] } }),
    prisma.pairing.deleteMany({ where: { wine: inCaves } }),
    prisma.wine.deleteMany({ where: inCaves }),
    prisma.photo.deleteMany({ where: inCaves }),
    prisma.exportLog.deleteMany({ where: inCaves }),
    prisma.imageSearchCost.deleteMany({ where: inCaves }),
    prisma.cave.deleteMany({ where: { id: { in: ids } } }),
  ]);
}
