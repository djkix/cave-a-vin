import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CaveRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Ligne de la liste des membres : un compte rattaché, ou une adresse invitée (`pending`). */
export interface MemberView {
  id: string;
  email: string;
  displayName: string | null;
  role: CaveRole;
  pending: boolean;
}

const ALREADY_MEMBER = 'Cette adresse est déjà membre';
const MEMBER_NOT_FOUND = 'Membre introuvable';

type MemberRow = {
  id: string;
  role: CaveRole;
  invitedEmail: string | null;
  user: { email: string; displayName: string | null } | null;
};

function toView(row: MemberRow): MemberView {
  if (row.user) return { id: row.id, email: row.user.email, displayName: row.user.displayName, role: row.role, pending: false };
  return { id: row.id, email: row.invitedEmail ?? '', displayName: null, role: row.role, pending: true };
}

const MEMBER_SELECT = {
  id: true,
  role: true,
  invitedEmail: true,
  user: { select: { email: true, displayName: true } },
} as const;

/**
 * Membres de la cave courante, gérés par son propriétaire. Toutes les
 * opérations sont bornées à `caveId` : une ligne d'une autre cave est
 * inexistante (404). Un membre retiré perd l'accès à sa requête suivante, car
 * la cave courante est revérifiée à chaque requête (CaveAccessGuard).
 */
@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Le propriétaire d'abord, puis par date d'ajout. */
  async list(caveId: string): Promise<MemberView[]> {
    const rows = await this.prisma.caveMember.findMany({
      where: { caveId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: MEMBER_SELECT,
    });
    return [...rows.filter((r) => r.role === 'OWNER'), ...rows.filter((r) => r.role !== 'OWNER')].map(toView);
  }

  /**
   * `email` déjà normalisé (minuscules, sans espaces). Un compte existant est
   * rattaché directement (VIEWER) ; s'il est en attente de validation, il
   * devient actif (l'invitation suffit) ; un compte bloqué reste bloqué. Sans
   * compte, une invitation attend sa première connexion Google. 409 si
   * l'adresse est déjà membre ou invitée (propriétaire compris), y compris
   * quand deux ajouts simultanés se croisent (unicité en base).
   */
  async add(caveId: string, email: string): Promise<MemberView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.appUser.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: { id: true, email: true, displayName: true, status: true },
        });
        const existing = await tx.caveMember.findFirst({
          where: { caveId, OR: [{ invitedEmail: email }, ...(user ? [{ userId: user.id }] : [])] },
          select: { id: true },
        });
        if (existing) throw new ConflictException(ALREADY_MEMBER);

        if (!user) {
          const row = await tx.caveMember.create({ data: { caveId, invitedEmail: email, role: 'VIEWER' } });
          return { id: row.id, email, displayName: null, role: row.role, pending: true };
        }
        if (user.status === 'PENDING') {
          await tx.appUser.updateMany({ where: { id: user.id, status: 'PENDING' }, data: { status: 'ACTIVE' } });
        }
        const row = await tx.caveMember.create({ data: { caveId, userId: user.id, role: 'VIEWER' } });
        return { id: row.id, email: user.email, displayName: user.displayName, role: row.role, pending: false };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(ALREADY_MEMBER);
      throw e;
    }
  }

  async remove(caveId: string, memberId: string): Promise<void> {
    const member = await this.prisma.caveMember.findFirst({ where: { id: memberId, caveId }, select: { id: true, role: true } });
    if (!member) throw new NotFoundException(MEMBER_NOT_FOUND);
    if (member.role === 'OWNER') throw new BadRequestException('Le propriétaire ne peut pas être retiré');
    // Bornée à la cave et au rôle : jamais la ligne du propriétaire.
    await this.prisma.caveMember.deleteMany({ where: { id: memberId, caveId, role: 'VIEWER' } });
  }

  async rename(caveId: string, name: string): Promise<{ id: string; name: string }> {
    return this.prisma.cave.update({ where: { id: caveId }, data: { name }, select: { id: true, name: true } });
  }
}
