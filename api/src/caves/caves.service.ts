import { Injectable } from '@nestjs/common';
import { Cave, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CaveOwner = { id: string; email: string; displayName: string | null };

/** « Cave de {nom affiché ou e-mail} », comme la migration. */
export function caveNameFor(owner: { email: string; displayName: string | null }): string {
  return `Cave de ${owner.displayName?.trim() || owner.email}`;
}

/** Création et attribution des caves (le propriétaire a toujours sa ligne OWNER). */
@Injectable()
export class CavesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Crée la cave d'un compte, dans la transaction de l'appelant. */
  createOwnedCave(tx: Prisma.TransactionClient, owner: CaveOwner): Promise<Cave> {
    return tx.cave.create({
      data: { name: caveNameFor(owner), ownerId: owner.id, members: { create: { userId: owner.id, role: 'OWNER' } } },
    });
  }

  /**
   * Une cave migrée sur une base sans administrateur actif (ni compte de
   * secours) n'a pas de propriétaire : le premier administrateur qui se
   * connecte sans avoir de cave reçoit la plus ancienne. Le verrou sur le
   * compte empêche deux connexions simultanées du même administrateur d'en
   * prendre deux ; la mise à jour conditionnelle (`owner_id IS NULL`) empêche
   * deux administrateurs de prendre la même. Rend l'id de la cave attribuée.
   */
  async claimOrphanCave(userId: string): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app_user WHERE id = ${userId} FOR UPDATE`;
      if (await tx.cave.findFirst({ where: { ownerId: userId }, select: { id: true } })) return null;

      const orphans = await tx.cave.findMany({
        where: { ownerId: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: 5,
      });
      for (const orphan of orphans) {
        const { count } = await tx.cave.updateMany({ where: { id: orphan.id, ownerId: null }, data: { ownerId: userId } });
        if (count === 0) continue;
        const membership = await tx.caveMember.findUnique({ where: { caveId_userId: { caveId: orphan.id, userId } }, select: { id: true } });
        if (membership) await tx.caveMember.update({ where: { id: membership.id }, data: { role: 'OWNER' } });
        else await tx.caveMember.create({ data: { caveId: orphan.id, userId, role: 'OWNER' } });
        return orphan.id;
      }
      return null;
    });
  }
}
