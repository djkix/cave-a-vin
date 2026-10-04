import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { compileApogeeRules, CompiledApogeeRules } from './apogee';

/**
 * Règles du moment, relues à chaque requête : une qualité de millésime ou une
 * garde modifiée se voit dès l'affichage suivant. Deux petites tables, lues en
 * parallèle — aucun cache, donc aucune valeur périmée possible.
 */
@Injectable()
export class ApogeeRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<CompiledApogeeRules> {
    const [overrides, qualities] = await Promise.all([this.prisma.guardOverride.findMany(), this.prisma.vintageQuality.findMany()]);
    return compileApogeeRules({
      guardOverrides: overrides.map((o) => ({ appellationId: o.appellationId, color: o.color, min: o.guardMinYears, max: o.guardMaxYears })),
      vintageQualities: qualities.map((q) => ({ region: q.region, year: q.year, quality: q.quality })),
    });
  }
}
