import { Injectable } from '@nestjs/common';
import { WineColor } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.service';

export type AppellationMatch =
  | { kind: 'exact' | 'fuzzy'; id: string; canonicalName: string; similarity: number }
  | { kind: 'none'; raw: string };

interface SeedRow {
  canonicalName: string;
  region: string | null;
  allowedColors: WineColor[];
  guardMinYears: number | null;
  guardMaxYears: number | null;
}

export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

@Injectable()
export class AppellationsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(raw: string): Promise<AppellationMatch> {
    const needle = normalizeLabel(raw);
    if (!needle) return { kind: 'none', raw };
    const rows = await this.prisma.$queryRaw<{ id: string; canonical_name: string; sim: number }[]>`
      SELECT id, canonical_name,
             similarity(unaccent_lower(canonical_name), ${needle}) AS sim
      FROM appellation
      ORDER BY sim DESC
      LIMIT 1`;
    const best = rows[0];
    if (!best || best.sim < 0.5) return { kind: 'none', raw };
    return {
      kind: best.sim >= 0.8 ? 'exact' : 'fuzzy',
      id: best.id,
      canonicalName: best.canonical_name,
      similarity: Number(best.sim),
    };
  }

  async seedFromFile(path: string): Promise<number> {
    const rows = JSON.parse(await readFile(path, 'utf8')) as SeedRow[];
    for (const r of rows) {
      await this.prisma.appellation.upsert({
        where: { canonicalName: r.canonicalName },
        update: { region: r.region, allowedColors: r.allowedColors, guardMinYears: r.guardMinYears, guardMaxYears: r.guardMaxYears },
        create: r,
      });
    }
    return rows.length;
  }
}
