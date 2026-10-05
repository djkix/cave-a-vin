import { Injectable } from '@nestjs/common';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { apogeeOf, CaveService } from '../cave/cave.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeStats, Stats, StatsMovement } from './stats';

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cave: CaveService,
    private readonly rules: ApogeeRulesService,
  ) {}

  /** Tout le journal est lu : quelques milliers de lignes, sommées en mémoire. */
  async compute(now = new Date()): Promise<Stats> {
    const [rows, rules, movements] = await Promise.all([
      this.cave.allWithStock(),
      this.rules.load(),
      this.prisma.movement.findMany({
        select: { id: true, wineId: true, delta: true, type: true, occurredAt: true, priceUnitCents: true, reversesId: true },
      }),
    ]);
    const year = now.getFullYear();
    const wines = rows.map((r) => ({
      id: r.id, producer: r.producer, cuvee: r.cuvee, vintage: r.vintage, color: r.color,
      region: r.region ?? null, quantity: r.quantity, apogee: apogeeOf(r, rules, year),
    }));
    return computeStats({ wines, movements: movements as StatsMovement[] }, now);
  }
}
