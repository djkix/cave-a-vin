import { Injectable } from '@nestjs/common';
import { CaveRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mainCaveId } from './main-cave';

export interface CaveSummary {
  id: string;
  name: string;
  role: CaveRole;
}

export interface CaveAccess {
  caveId: string;
  role: CaveRole;
}

/**
 * Caves accessibles à un compte et cave courante. Seules les lignes
 * `cave_member` rattachées au compte comptent : une invitation en attente
 * (`invited_email`) ne donne aucun accès. Exception : le compte de secours est
 * propriétaire de la cave de l'administrateur principal, pour pouvoir saisir
 * des entrées et des sorties pendant une panne de Google.
 */
@Injectable()
export class CaveContextService {
  constructor(private readonly prisma: PrismaService) {}

  /** Caves du compte : la sienne (OWNER) d'abord, puis par nom. */
  async listForUser(userId: string): Promise<CaveSummary[]> {
    return (await this.memberships(userId)).sort((a, b) =>
      a.role === b.role ? a.name.localeCompare(b.name, 'fr') : a.role === 'OWNER' ? -1 : 1,
    );
  }

  /** Rôle du compte dans cette cave, null s'il n'y a pas accès. */
  async findAccess(userId: string, caveId: string): Promise<CaveAccess | null> {
    const row = (await this.memberships(userId)).find((r) => r.id === caveId);
    return row ? { caveId: row.id, role: row.role } : null;
  }

  /**
   * Cave courante : celle de la session si elle est encore accessible, sinon
   * la cave OWNER du compte, sinon sa plus ancienne invitation (date d'ajout du
   * membre), sinon aucune.
   */
  async resolveCurrent(userId: string, sessionCaveId?: string | null): Promise<CaveAccess | null> {
    const rows = await this.memberships(userId);
    const pick = sessionCaveId ? rows.find((r) => r.id === sessionCaveId) : undefined;
    const row = pick ?? rows.find((r) => r.role === 'OWNER') ?? rows[0];
    return row ? { caveId: row.id, role: row.role } : null;
  }

  /** Caves du compte par date d'ajout ; pour le compte de secours, la cave principale en OWNER. */
  private async memberships(userId: string): Promise<CaveSummary[]> {
    const rows = await this.prisma.caveMember.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { role: true, cave: { select: { id: true, name: true } } },
    });
    const caves = rows.map((r) => ({ id: r.cave.id, name: r.cave.name, role: r.role }));
    const user = await this.prisma.appUser.findUnique({ where: { id: userId }, select: { isBreakGlass: true } });
    if (!user?.isBreakGlass) return caves;
    const mainId = await mainCaveId(this.prisma);
    const main = mainId ? await this.prisma.cave.findUnique({ where: { id: mainId }, select: { id: true, name: true } }) : null;
    if (!main) return caves;
    return [{ ...main, role: 'OWNER' }, ...caves.filter((c) => c.id !== main.id)];
  }
}
