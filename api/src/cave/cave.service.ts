import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Apogee, ApogeeWineInput, CompiledApogeeRules, estimateApogee, isDrinkSoon, sortByApogeeEnd } from '../apogee/apogee';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { ManualApogeeInput } from '../apogee/dto';
import { PrismaService } from '../prisma/prisma.service';
import { producerKeyOf } from '../producers/producer-key';
import { PRODUCER_PROFILE_INCLUDE, producerProfileOf } from '../producers/producer-profile.view';
import { parseExtraction } from '../vision/extraction-schema';
import { ExitCandidate, ExitOutcome, ExitRead, rankExitCandidates } from '../wines/exit-ranking';
import { CaveFilter, CaveRow, filterCave } from './cave-filter';
import { matchDish } from './dish-filter';

export type ExitCandidatesResponse =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'FAILED'; errorMessage: string | null }
  | { status: 'DONE'; outcome: ExitOutcome; read: ExitRead; candidates: ExitCandidate[] };

/** Colonnes de note et d'accords lues avec chaque vin ; facultatives pour les lignes construites à la main. */
interface RatingColumns { rating?: number | null; ratedAt?: Date | null; ratedBy?: string | null }
interface PairingColumns {
  pairingStatus?: string | null;
  pairingDishes?: string[] | null;
  pairingError?: string | null;
  pairingGeneratedAt?: Date | null;
}

/** Provenance d'une vignette trouvée sur le web : montrée sur la fiche seulement. */
interface ReferenceSourceColumns { referencePhotoSource?: string | null; referencePhotoSourceUrl?: string | null }

/** Ligne lue en base : la ligne publique plus ce qu'il faut pour estimer l'apogée, la note et les accords. */
export type CaveDbRow = CaveRow & Omit<ApogeeWineInput, 'vintage' | 'color'> & RatingColumns & PairingColumns & ReferenceSourceColumns;

export interface Rating { value: number; ratedAt: Date; ratedBy: string | null }

export type CaveItem = CaveRow & { apogee: Apogee; rating: Rating | null; matchedDish?: string };

export function ratingOf(row: CaveDbRow): Rating | null {
  return row.rating == null || row.ratedAt == null ? null : { value: Number(row.rating), ratedAt: row.ratedAt, ratedBy: row.ratedBy ?? null };
}

/** Apogée d'une ligne lue en base : partagé par la liste, la fiche et les statistiques. */
export function apogeeOf(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): Apogee {
  return estimateApogee(
    {
      vintage: row.vintage, color: row.color, appellationId: row.appellationId ?? null, region: row.region ?? null,
      referenceGuardMin: row.referenceGuardMin ?? null, referenceGuardMax: row.referenceGuardMax ?? null,
      apogeeMin: row.apogeeMin ?? null, apogeeMax: row.apogeeMax ?? null, apogeeSource: row.apogeeSource ?? null,
    },
    rules, currentYear,
  );
}

export interface PairingView { status: string; dishes: string[]; errorMessage: string | null; generatedAt: Date | null }

export function pairingOf(row: CaveDbRow): PairingView | null {
  return row.pairingStatus
    ? { status: row.pairingStatus, dishes: row.pairingDishes ?? [], errorMessage: row.pairingError ?? null, generatedAt: row.pairingGeneratedAt ?? null }
    : null;
}

function toItem(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): CaveItem {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars -- champs internes retirés de la réponse */
    appellationId, region, referenceGuardMin, referenceGuardMax, apogeeMin, apogeeMax, apogeeSource,
    rating, ratedAt, ratedBy, pairingStatus, pairingDishes, pairingError, pairingGeneratedAt,
    referencePhotoSource, referencePhotoSourceUrl,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...pub
  } = row;
  return { ...pub, apogee: apogeeOf(row, rules, currentYear), rating: ratingOf(row) };
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
             , w.rating::FLOAT8 AS rating, w.rated_at AS "ratedAt", COALESCE(u.display_name, u.email) AS "ratedBy",
             p.status::TEXT AS "pairingStatus", p.dishes AS "pairingDishes", p.error_message AS "pairingError",
             p.generated_at AS "pairingGeneratedAt",
             w.reference_photo_source AS "referencePhotoSource", w.reference_photo_source_url AS "referencePhotoSourceUrl"
      FROM wine w
      LEFT JOIN stock_courant s ON s.wine_id = w.id
      LEFT JOIN appellation a ON a.id = w.appellation_id
      LEFT JOIN app_user u ON u.id = w.rated_by
      LEFT JOIN pairing p ON p.wine_id = w.id
      ORDER BY w.producer ASC, w.vintage ASC NULLS FIRST`;
  }

  async list(filter: CaveFilter): Promise<CaveItem[]> {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const year = new Date().getFullYear();
    const kept = filterCave(rows, filter);
    let items = kept.map((r) => toItem(r, rules, year));
    if (filter.drinkSoon) items = sortByApogeeEnd(items.filter((i) => isDrinkSoon(i.apogee, year)));
    else if (filter.noApogee) items = items.filter((i) => i.apogee.max == null);
    if (filter.dish) {
      const dishesById = new Map(kept.map((r) => [r.id, r.pairingDishes ?? null]));
      const query = filter.dish;
      items = items.flatMap((i) => {
        const matchedDish = matchDish(dishesById.get(i.id), query);
        return matchedDish ? [{ ...i, matchedDish }] : [];
      });
      // Pour un plat, les bouteilles à boire en priorité passent devant.
      const soon = sortByApogeeEnd(items.filter((i) => isDrinkSoon(i.apogee, year)));
      items = [...soon, ...items.filter((i) => !isDrinkSoon(i.apogee, year))];
    }
    return items;
  }

  async detail(id: string) {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException('Vin introuvable');
    const producerKey = producerKeyOf(row.producer);
    const [movements, profile] = await Promise.all([
      this.prisma.movement.findMany({
        where: { wineId: id },
        orderBy: { occurredAt: 'desc' },
        take: 10,
        select: { id: true, delta: true, type: true, occurredAt: true, note: true, reversesId: true },
      }),
      // Un descriptif par domaine, partagé par tous ses vins : lien par la clé normalisée.
      producerKey ? this.prisma.producerProfile.findUnique({ where: { producerKey }, include: PRODUCER_PROFILE_INCLUDE }) : null,
    ]);
    return {
      wine: {
        ...toItem(row, rules, new Date().getFullYear()),
        pairing: pairingOf(row),
        // Vignette trouvée sur le web : « Image : {source} » (lien) sous la vignette ; null pour une photo de l'utilisateur.
        referencePhotoSource: row.referencePhotoSource ?? null,
        referencePhotoSourceUrl: row.referencePhotoSourceUrl ?? null,
        // Toujours présente (sauf nom sans lettre ni chiffre) : la fiche peut écrire ou régénérer avant tout profil.
        producerKey: producerKey || null,
        producerProfile: producerProfileOf(profile),
      },
      movements,
    };
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
    await this.updateWine(id, { apogeeMin: input.min, apogeeMax: input.max, apogeeSource: 'MANUEL' });
    return (await this.detail(id)).wine.apogee;
  }

  async clearManualApogee(id: string): Promise<Apogee> {
    await this.updateWine(id, { apogeeMin: null, apogeeMax: null, apogeeSource: null });
    return (await this.detail(id)).wine.apogee;
  }

  async setRating(id: string, value: number, userId: string): Promise<Rating | null> {
    await this.updateWine(id, { rating: value, ratedAt: new Date(), ratedById: userId });
    return (await this.detail(id)).wine.rating;
  }

  async clearRating(id: string): Promise<null> {
    await this.updateWine(id, { rating: null, ratedAt: null, ratedById: null });
    return null;
  }

  private async updateWine(id: string, data: Prisma.WineUncheckedUpdateInput) {
    try {
      await this.prisma.wine.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Vin introuvable');
      throw e;
    }
  }
}
