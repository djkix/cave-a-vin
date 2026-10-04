import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Apogee, ApogeeWineInput, CompiledApogeeRules, estimateApogee } from '../apogee/apogee';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { ManualApogeeInput } from '../apogee/dto';
import { PrismaService } from '../prisma/prisma.service';
import { parseExtraction } from '../vision/extraction-schema';
import { ExitCandidate, ExitOutcome, ExitRead, rankExitCandidates } from '../wines/exit-ranking';
import { CaveFilter, CaveRow, filterCave } from './cave-filter';

export type ExitCandidatesResponse =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'FAILED'; errorMessage: string | null }
  | { status: 'DONE'; outcome: ExitOutcome; read: ExitRead; candidates: ExitCandidate[] };

/** Ligne lue en base : la ligne publique plus ce qu'il faut pour estimer l'apogée. */
type CaveDbRow = CaveRow & Omit<ApogeeWineInput, 'vintage' | 'color'>;

export type CaveItem = CaveRow & { apogee: Apogee };

function toItem(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): CaveItem {
  const { appellationId, region, referenceGuardMin, referenceGuardMax, apogeeMin, apogeeMax, apogeeSource, ...pub } = row;
  const apogee = estimateApogee(
    {
      vintage: row.vintage, color: row.color, appellationId: appellationId ?? null, region: region ?? null,
      referenceGuardMin: referenceGuardMin ?? null, referenceGuardMax: referenceGuardMax ?? null,
      apogeeMin: apogeeMin ?? null, apogeeMax: apogeeMax ?? null, apogeeSource: apogeeSource ?? null,
    },
    rules, currentYear,
  );
  return { ...pub, apogee };
}

@Injectable()
export class CaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: ApogeeRulesService,
  ) {}

  /**
   * Tous les vins avec leur stock. Lu en une requête puis filtré en mémoire : la
   * cave compte quelques centaines de références, et le filtre se teste ainsi
   * sans base.
   */
  allWithStock(): Promise<CaveDbRow[]> {
    return this.prisma.$queryRaw<CaveDbRow[]>`
      SELECT w.id, w.producer, w.cuvee, w.appellation_raw AS "appellationRaw", w.vintage,
             w.color::TEXT AS color, w.format_cl AS "formatCl", w.reference_photo_id AS "referencePhotoId",
             COALESCE(s.quantity, 0)::INTEGER AS quantity,
             w.appellation_id AS "appellationId", a.region,
             a.guard_min_years AS "referenceGuardMin", a.guard_max_years AS "referenceGuardMax",
             w.apogee_min AS "apogeeMin", w.apogee_max AS "apogeeMax", w.apogee_source AS "apogeeSource"
      FROM wine w
      LEFT JOIN stock_courant s ON s.wine_id = w.id
      LEFT JOIN appellation a ON a.id = w.appellation_id
      ORDER BY w.producer ASC, w.vintage ASC NULLS FIRST`;
  }

  async list(filter: CaveFilter): Promise<CaveItem[]> {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const year = new Date().getFullYear();
    return filterCave(rows, filter).map((r) => toItem(r, rules, year));
  }

  async detail(id: string) {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException('Vin introuvable');
    const movements = await this.prisma.movement.findMany({
      where: { wineId: id },
      orderBy: { occurredAt: 'desc' },
      take: 10,
      select: { id: true, delta: true, type: true, occurredAt: true, note: true, reversesId: true },
    });
    return { wine: toItem(row, rules, new Date().getFullYear()), movements };
  }

  async exitCandidates(photoId: string): Promise<ExitCandidatesResponse> {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    if (photo.status === 'PENDING' || photo.status === 'PROCESSING') return { status: photo.status };
    if (photo.status === 'FAILED') return { status: 'FAILED', errorMessage: photo.errorMessage ?? null };

    let read: ExitRead;
    try {
      const e = parseExtraction(photo.rawExtraction);
      read = { producer: e.producer.value, cuvee: e.cuvee.value, appellation: e.appellation.value, vintage: e.vintage.value };
    } catch {
      // Un prix faux est pire qu'un prix absent ; une sortie fausse aussi : une
      // lecture inexploitable renvoie vers la liste, jamais vers un vin deviné.
      return { status: 'FAILED', errorMessage: 'Lecture de l’étiquette inexploitable' };
    }
    const inStock = (await this.allWithStock())
      .filter((r) => r.quantity > 0)
      .map((r) => ({
        wine: { id: r.id, producer: r.producer, cuvee: r.cuvee, appellationRaw: r.appellationRaw, vintage: r.vintage, color: r.color, formatCl: r.formatCl },
        quantity: r.quantity,
        referencePhotoId: r.referencePhotoId,
      }));
    return { status: 'DONE', read, ...rankExitCandidates(read, inStock) };
  }

  async setManualApogee(id: string, input: ManualApogeeInput): Promise<Apogee> {
    await this.updateApogee(id, { apogeeMin: input.min, apogeeMax: input.max, apogeeSource: 'MANUEL' });
    return (await this.detail(id)).wine.apogee;
  }

  async clearManualApogee(id: string): Promise<Apogee> {
    await this.updateApogee(id, { apogeeMin: null, apogeeMax: null, apogeeSource: null });
    return (await this.detail(id)).wine.apogee;
  }

  private async updateApogee(id: string, data: { apogeeMin: number | null; apogeeMax: number | null; apogeeSource: string | null }) {
    try {
      await this.prisma.wine.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Vin introuvable');
      throw e;
    }
  }
}
