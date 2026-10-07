import { Injectable } from '@nestjs/common';
import { CaveRole } from '@prisma/client';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { apogeeOf, CaveService } from '../cave/cave.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeStats, Stats, statsForRole, StatsMovement, ViewerStats } from './stats';

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cave: CaveService,
    private readonly rules: ApogeeRulesService,
  ) {}

  /**
   * Statistiques de la cave `caveId`. Tout son journal est lu : quelques
   * milliers de lignes, sommées en mémoire. Un VIEWER ne reçoit ni la valeur au
   * prix d'achat ni le classement « les plus chères » (champs absents).
   */
  compute(caveId: string, role: 'OWNER', now?: Date): Promise<Stats>;
  compute(caveId: string, role: 'VIEWER', now?: Date): Promise<ViewerStats>;
  compute(caveId: string, role: CaveRole, now?: Date): Promise<Stats | ViewerStats>;
  async compute(caveId: string, role: CaveRole, now = new Date()): Promise<Stats | ViewerStats> {
    const [rows, rules, movements] = await Promise.all([
      this.cave.allWithStock(caveId),
      this.rules.load(),
      this.prisma.movement.findMany({
        where: { wine: { caveId } },
        select: { id: true, wineId: true, delta: true, type: true, occurredAt: true, priceUnitCents: true, reversesId: true },
      }),
    ]);
    const year = now.getFullYear();
    const wines = rows.map((r) => ({
      id: r.id, producer: r.producer, cuvee: r.cuvee, vintage: r.vintage, color: r.color,
      region: r.region ?? null, quantity: r.quantity, apogee: apogeeOf(r, rules, year), rating: r.rating ?? null,
    }));
    return statsForRole(computeStats({ wines, movements: movements as StatsMovement[] }, now), role);
  }
}
