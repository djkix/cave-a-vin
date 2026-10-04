import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WineColor } from '@prisma/client';
import { normalizeLabel } from '../appellations/appellations.service';
import { PrismaService } from '../prisma/prisma.service';
import { VintageQualityInput } from './dto';

const SEARCH_LIMIT = 20;

export interface GuardInput {
  appellationId: string;
  color?: WineColor | null;
  min: number;
  max: number;
}

@Injectable()
export class ApogeeAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private async regions(): Promise<string[]> {
    const rows = await this.prisma.appellation.findMany({
      where: { region: { not: null } },
      select: { region: true },
      distinct: ['region'],
      orderBy: { region: 'asc' },
    });
    return rows.map((r) => r.region as string);
  }

  async listVintages() {
    const [regions, qualities] = await Promise.all([
      this.regions(),
      this.prisma.vintageQuality.findMany({ orderBy: [{ region: 'asc' }, { year: 'desc' }] }),
    ]);
    return { regions, qualities: qualities.map((q) => ({ region: q.region, year: q.year, quality: q.quality })) };
  }

  async setVintage(input: VintageQualityInput) {
    if (!(await this.regions()).includes(input.region)) throw new BadRequestException('Région inconnue du référentiel');
    const row = await this.prisma.vintageQuality.upsert({
      where: { region_year: { region: input.region, year: input.year } },
      create: { region: input.region, year: input.year, quality: input.quality },
      update: { quality: input.quality },
    });
    return { region: row.region, year: row.year, quality: row.quality };
  }

  async removeVintage(region: string, year: number): Promise<void> {
    await this.prisma.vintageQuality.deleteMany({ where: { region, year } });
  }

  async searchGuards(q: string) {
    const words = normalizeLabel(q).split(' ').filter(Boolean);
    const all = await this.prisma.appellation.findMany({ include: { guardOverrides: true }, orderBy: { canonicalName: 'asc' } });
    return all
      .filter((a) => words.every((w) => normalizeLabel(a.canonicalName).includes(w)))
      .slice(0, SEARCH_LIMIT)
      .map((a) => ({
        id: a.id, canonicalName: a.canonicalName, region: a.region,
        guardMinYears: a.guardMinYears, guardMaxYears: a.guardMaxYears,
        overrides: a.guardOverrides.map((o) => ({ id: o.id, color: o.color, min: o.guardMinYears, max: o.guardMaxYears })),
      }));
  }

  async setGuard(input: GuardInput) {
    const appellation = await this.prisma.appellation.findUnique({ where: { id: input.appellationId } });
    if (!appellation) throw new NotFoundException('Appellation introuvable');
    const color = input.color ?? null;
    const data = { guardMinYears: input.min, guardMaxYears: input.max };
    const existing = await this.prisma.guardOverride.findFirst({ where: { appellationId: input.appellationId, color } });
    let row;
    if (existing) {
      row = await this.prisma.guardOverride.update({ where: { id: existing.id }, data });
    } else {
      try {
        row = await this.prisma.guardOverride.create({ data: { appellationId: input.appellationId, color, ...data } });
      } catch (e) {
        // Deux administrateurs au même instant : l'index partiel a refusé le
        // second ajout ; on met à jour la ligne écrite par le premier.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const raced = await this.prisma.guardOverride.findFirst({ where: { appellationId: input.appellationId, color } });
        if (!raced) throw e;
        row = await this.prisma.guardOverride.update({ where: { id: raced.id }, data });
      }
    }
    return { id: row.id, color: row.color, min: row.guardMinYears, max: row.guardMaxYears };
  }

  async removeGuard(id: string): Promise<void> {
    try {
      await this.prisma.guardOverride.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Ajustement introuvable');
      throw e;
    }
  }
}
