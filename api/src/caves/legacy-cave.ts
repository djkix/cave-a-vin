import { PrismaClient } from '@prisma/client';

/** Verrou consultatif qui sérialise la création de la cave de transition. */
const LEGACY_CAVE_LOCK = 2026_10_12;

/** Même nom que la migration : « Cave de {nom affiché ou e-mail} », sinon « Ma cave ». */
export function legacyCaveName(owner: { email: string; displayName: string | null } | null): string {
  if (!owner) return 'Ma cave';
  return `Cave de ${owner.displayName?.trim() || owner.email}`;
}

type CaveReader = Pick<PrismaClient, 'cave'>;

/** La plus ancienne cave qui a un propriétaire (une cave de test n'en a pas), sinon la plus ancienne. */
async function findLegacyCave(db: CaveReader): Promise<{ id: string } | null> {
  const oldest = { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }], select: { id: true } };
  return (await db.cave.findFirst({ where: { ownerId: { not: null } }, ...oldest })) ?? (await db.cave.findFirst(oldest));
}

/**
 * TRANSITION (tâche 1 du passage multi-caves) — à supprimer quand toutes les
 * routes reçoivent la cave courante (tâches 3 et 4). Chaque appel est marqué
 * `TODO(multi-caves)`.
 *
 * Rend la cave unique de l'ancien fonctionnement : la plus ancienne qui a un
 * propriétaire, sinon la plus ancienne. S'il n'y en a aucune (installation
 * neuve, base de test vidée), la crée comme la migration l'aurait fait :
 * propriétaire = plus ancien administrateur actif hors compte de secours, sinon
 * le compte de secours actif, sinon personne.
 */
export async function resolveLegacyCaveId(prisma: PrismaClient): Promise<string> {
  const existing = await findLegacyCave(prisma);
  if (existing) return existing.id;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEGACY_CAVE_LOCK})`;
    const raced = await findLegacyCave(tx);
    if (raced) return raced.id;

    const ownerSelect = { select: { id: true, email: true, displayName: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] };
    const owner =
      (await tx.appUser.findFirst({ where: { status: 'ACTIVE', isAdmin: true, isBreakGlass: false }, ...ownerSelect })) ??
      (await tx.appUser.findFirst({ where: { status: 'ACTIVE', isBreakGlass: true }, ...ownerSelect }));
    const cave = await tx.cave.create({
      data: {
        name: legacyCaveName(owner),
        ownerId: owner?.id ?? null,
        ...(owner ? { members: { create: { userId: owner.id, role: 'OWNER' as const } } } : {}),
      },
      select: { id: true },
    });
    return cave.id;
  });
}
