import { Injectable } from '@nestjs/common';
import { CaveRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
 * (`invited_email`) ne donne aucun accès.
 */
@Injectable()
export class CaveContextService {
  constructor(private readonly prisma: PrismaService) {}

  /** Caves du compte : la sienne (OWNER) d'abord, puis par nom. */
  async listForUser(userId: string): Promise<CaveSummary[]> {
    const rows = await this.prisma.caveMember.findMany({
      where: { userId },
      select: { role: true, cave: { select: { id: true, name: true } } },
    });
    return rows
      .map((r) => ({ id: r.cave.id, name: r.cave.name, role: r.role }))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, 'fr') : a.role === 'OWNER' ? -1 : 1));
  }

  /** Rôle du compte dans cette cave, null s'il n'y a pas accès. */
  async findAccess(userId: string, caveId: string): Promise<CaveAccess | null> {
    const row = await this.prisma.caveMember.findFirst({ where: { userId, caveId }, select: { caveId: true, role: true } });
    return row ? { caveId: row.caveId, role: row.role } : null;
  }

  /**
   * Cave courante : celle de la session si elle est encore accessible, sinon
   * la cave OWNER du compte, sinon sa plus ancienne invitation (date d'ajout du
   * membre), sinon aucune.
   */
  async resolveCurrent(userId: string, sessionCaveId?: string | null): Promise<CaveAccess | null> {
    const rows = await this.prisma.caveMember.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { caveId: true, role: true },
    });
    const pick = sessionCaveId ? rows.find((r) => r.caveId === sessionCaveId) : undefined;
    const row = pick ?? rows.find((r) => r.role === 'OWNER') ?? rows[0];
    return row ? { caveId: row.caveId, role: row.role } : null;
  }
}
