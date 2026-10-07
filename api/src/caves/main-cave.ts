import { PrismaService } from '../prisma/prisma.service';

/**
 * Cave de l'administrateur principal : la plus ancienne cave possédée par le
 * plus ancien administrateur actif qui n'est pas le compte de secours. Aucun
 * (ou sans cave) : null. Exemptée de la part de budget par cave ; le compte de
 * secours y écrit comme le propriétaire.
 */
export async function mainCaveId(prisma: Pick<PrismaService, 'appUser' | 'cave'>): Promise<string | null> {
  const admin = await prisma.appUser.findFirst({
    where: { isAdmin: true, isBreakGlass: false, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (!admin) return null;
  const cave = await prisma.cave.findFirst({
    where: { ownerId: admin.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return cave?.id ?? null;
}
