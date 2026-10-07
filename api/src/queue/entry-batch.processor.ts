import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PhotosService } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { VisionBatchMismatchError } from '../vision/gemini-vision.provider';
import { VISION_PROVIDER, VisionProvider } from '../vision/vision-provider.interface';
import { ENTRY_BATCH_CALL_TIMEOUT_MS, ENTRY_BATCH_SIZE, ENTRY_CANDIDATES_SCAN, RESERVATION_MS, shouldRun, splitCost } from './entry-batch';
import { EXTRACTION_ATTEMPTS, extractionBackoffDelay } from './extraction.queue';
import { CONFIGURATION_DEFERRAL_REASON, deferralReason, isConfigurationError, isTransientVisionFailure } from './transient-failure';
import { CaveBudgetShareExceededError, VisionBudgetExceededError, VisionBudgetService } from './vision-budget.service';

interface Reserved {
  id: string;
  attempts: number;
  /** Coût déjà dépensé sur la photo (appels précédents), cumulé à chaque appel. */
  costCents: number | null;
}

type Readable = Reserved & { data: Buffer };

/** Lot réservé : des photos d'une seule cave. */
interface ReservedBatch {
  caveId: string;
  photos: Reserved[];
}

/**
 * Nombre maximal de lots reportés pour part de cave atteinte dans un même
 * passage : chacun ne coûte qu'une réservation et une écriture (aucun appel
 * Gemini), et les caves restantes passent au passage suivant.
 */
const MAX_OVER_SHARE_CAVES_PER_TICK = 20;

const MIME = 'image/jpeg';

/** Seul message stocké pour une lecture en échec : le texte brut (SDK, Zod) reste dans les logs. */
const UNREADABLE = 'Lecture de l’étiquette inexploitable';

/**
 * Analyse des photos d'entrée par lots : la table `photo` sert de file. Chaque
 * passage reprend les réservations échues, décide s'il faut lancer un lot,
 * réserve au plus huit photos, puis les fait lire en un seul appel Gemini.
 *
 * Aucune exception ne sort de `tick` : une photo réservée finit toujours DONE,
 * FAILED ou PENDING (reportée), et au pire sa réservation expire au bout de
 * cinq minutes et elle est reprise.
 */
@Injectable()
export class EntryBatchProcessor {
  private readonly logger = new Logger(EntryBatchProcessor.name);

  /** Délai maximal d'un appel Gemini ; modifiable par les tests. */
  callTimeoutMs = ENTRY_BATCH_CALL_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  /**
   * Un lot ne contient que des photos d'une même cave : celle de la plus
   * ancienne candidate. Si cette cave a atteint sa part mensuelle, son lot est
   * reporté (comme pour le plafond global) et le passage continue avec la plus
   * ancienne candidate des autres caves : une cave à court de budget ne
   * bloque jamais les autres. Au plus un appel Gemini par passage, comme avant.
   */
  async tick(now = new Date()): Promise<{ processed: number }> {
    try {
      await this.reclaimExpired(now);
    } catch (e) {
      this.logger.error(`Lot d'entrée : préparation impossible : ${messageOf(e)}`);
      return { processed: 0 };
    }

    const overShare: string[] = [];
    let processed = 0;
    while (overShare.length < MAX_OVER_SHARE_CAVES_PER_TICK) {
      let batch: ReservedBatch | null;
      try {
        const candidates = await this.prisma.photo.findMany({
          where: { ...this.candidateWhere(now), ...(overShare.length > 0 ? { caveId: { notIn: overShare } } : {}) },
          orderBy: { createdAt: 'asc' },
          take: ENTRY_CANDIDATES_SCAN,
          select: { createdAt: true, nextAttemptAt: true },
        });
        if (!shouldRun(candidates, now)) break;
        batch = await this.reserve(now, overShare);
      } catch (e) {
        this.logger.error(`Lot d'entrée : préparation impossible : ${messageOf(e)}`);
        break;
      }
      if (!batch) break;
      processed += batch.photos.length;
      if ((await this.runBatch(batch, now)) !== 'over-share') break;
      overShare.push(batch.caveId);
    }
    return { processed };
  }

  /** Traite un lot réservé sans jamais laisser sortir d'exception. */
  private async runBatch(batch: ReservedBatch, now: Date): Promise<'done' | 'over-share'> {
    const settled = new Set<string>();
    try {
      return await this.processBatch(batch, now, settled);
    } catch (e) {
      // Erreur imprévue (écriture en base, bogue) : les photos encore réservées
      // reviennent en attente plutôt que de rester PROCESSING jusqu'à l'échéance.
      this.logger.error(`Lot d'entrée interrompu : ${messageOf(e)}`);
      const rest = batch.photos.filter((p) => !settled.has(p.id));
      try {
        await this.settleFailure(rest, e, now, settled);
      } catch (e2) {
        this.logger.error(`Lot d'entrée : remise en attente impossible, reprise à l'échéance : ${messageOf(e2)}`);
      }
      return 'done';
    }
  }

  private candidateWhere(now: Date): Prisma.PhotoWhereInput {
    return {
      purpose: 'ENTRY',
      status: 'PENDING',
      dismissedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    };
  }

  /**
   * Une photo ENTRY encore PROCESSING dont la réservation a expiré (worker arrêté
   * en plein lot) ou qui n'en a jamais eu (ancien travail BullMQ interrompu, photo
   * de sortie reprise en entrée pendant son analyse) revient dans la file. La
   * reprise compte comme une tentative : une photo qui fait tomber le worker à
   * chaque lecture finit en échec au lieu de tourner sans fin.
   */
  private async reclaimExpired(now: Date): Promise<void> {
    const stuck: Prisma.PhotoWhereInput = {
      purpose: 'ENTRY',
      status: 'PROCESSING',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    };
    const abandoned = await this.prisma.photo.updateMany({
      where: { ...stuck, attempts: { gte: EXTRACTION_ATTEMPTS - 1 } },
      data: {
        status: 'FAILED',
        attempts: { increment: 1 },
        nextAttemptAt: null,
        errorMessage: `Analyse interrompue (worker arrêté en plein lot) — abandon après ${EXTRACTION_ATTEMPTS} tentatives`,
      },
    });
    const requeued = await this.prisma.photo.updateMany({
      where: { ...stuck, attempts: { lt: EXTRACTION_ATTEMPTS - 1 } },
      data: { status: 'PENDING', attempts: { increment: 1 }, nextAttemptAt: null },
    });
    if (requeued.count + abandoned.count > 0) {
      this.logger.warn(
        `Photos d'entrée bloquées en analyse : ${requeued.count} remise(s) en file, ${abandoned.count} abandonnée(s)`,
      );
    }
  }

  /**
   * `FOR UPDATE SKIP LOCKED` : deux passages simultanés (deux workers) ne
   * réservent jamais la même photo. Une seule cave par lot : la sous-requête
   * (évaluée une fois) donne la cave de la plus ancienne candidate hors caves
   * écartées ; la requête principale ne verrouille que des photos de cette
   * cave. Un passage concurrent qui vise la même cave prend les photos
   * restantes, ou rien : jamais deux caves dans un lot, jamais deux fois une
   * photo. Les dates sont comparées en UTC, comme Prisma les écrit, quel que
   * soit le fuseau de la session PostgreSQL.
   */
  private async reserve(now: Date, skippedCaves: string[]): Promise<ReservedBatch | null> {
    const deadline = new Date(now.getTime() + RESERVATION_MS);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<Reserved & { caveId: string }>>`
        SELECT id, cave_id AS "caveId", attempts, cost_cents AS "costCents" FROM photo
        WHERE purpose = 'ENTRY' AND status = 'PENDING' AND dismissed_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= (${now}::timestamptz AT TIME ZONE 'UTC'))
          AND cave_id = (
            SELECT cave_id FROM photo
            WHERE purpose = 'ENTRY' AND status = 'PENDING' AND dismissed_at IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= (${now}::timestamptz AT TIME ZONE 'UTC'))
              AND cave_id <> ALL(${skippedCaves}::text[])
            ORDER BY created_at
            LIMIT 1
          )
        ORDER BY created_at
        LIMIT ${ENTRY_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return null;
      await tx.photo.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: 'PROCESSING', nextAttemptAt: deadline },
      });
      return {
        caveId: rows[0].caveId,
        photos: rows.map((r) => ({
          id: r.id,
          attempts: Number(r.attempts),
          costCents: r.costCents === null ? null : Number(r.costCents),
        })),
      };
    });
  }

  /**
   * Plafond global, puis part mensuelle de la cave du lot : l'un ou l'autre
   * atteint, le lot est reporté sans appel (la photo n'est jamais perdue).
   * `over-share` : seule la cave est à court, le passage peut continuer.
   */
  private async processBatch(batch: ReservedBatch, now: Date, settled: Set<string>): Promise<'done' | 'over-share'> {
    const reserved = batch.photos;
    try {
      await this.budget.assertUnderCap();
      await this.budget.assertCaveUnderShare(batch.caveId);
    } catch (e) {
      await this.settleFailure(reserved, e, now, settled);
      return e instanceof CaveBudgetShareExceededError ? 'over-share' : 'done';
    }
    await this.readBatch(reserved, now, settled);
    return 'done';
  }

  private async readBatch(reserved: Reserved[], now: Date, settled: Set<string>): Promise<void> {

    const readable: Readable[] = [];
    for (const photo of reserved) {
      try {
        // Même objet que la réservation : une dépense notée ici reste visible du
        // rattrapage de `tick` si le lot est interrompu.
        readable.push(Object.assign(photo, { data: await this.photos.readNormalized(photo.id) }));
      } catch (e) {
        this.logger.warn(`Photo d'entrée ${photo.id} : image illisible : ${messageOf(e)}`);
        await this.fail(photo, 'Image introuvable', settled);
      }
    }
    if (readable.length === 0) return;
    if (readable.length === 1) {
      // Une photo seule passe par l'appel simple : sa consigne (un objet) est
      // celle que le modèle suit le mieux, et le coût est celui de cet appel.
      await this.readEachAlone(readable, now, settled);
      return;
    }

    let batch;
    try {
      batch = await this.withTimeout(this.vision.extractWineLabels(readable.map((p) => ({ data: p.data, mimeType: MIME }))));
    } catch (e) {
      if (e instanceof VisionBatchMismatchError) {
        // L'appel a abouti et il est facturé : sa part reste comptée sur chaque photo.
        const share = splitCost(e.costCents, readable.length);
        readable.forEach((p) => spend(p, share));
        this.logger.warn(`Lot mélangé (${e.message}) : relecture photo par photo`);
        await this.readEachAlone(readable, now, settled);
        return;
      }
      await this.settleFailure(readable, e, now, settled);
      return;
    }

    const share = splitCost(batch.costCents, readable.length);
    for (let i = 0; i < readable.length; i++) {
      const item = batch.items[i];
      const photo = readable[i];
      spend(photo, share);
      if (!item || 'error' in item) {
        await this.fail(photo, UNREADABLE, settled);
        continue;
      }
      await this.done(photo, { raw: item.raw, model: batch.model, latencyMs: batch.latencyMs }, settled);
    }
    this.logger.log(`Lot d'entrée de ${readable.length} photo(s) lu en ${batch.latencyMs} ms`);
  }

  /**
   * Lot mélangé (ou photo seule) : chaque photo est relue seule, aucune lecture
   * ne peut être attribuée à une autre. À la première panne passagère ou erreur
   * de configuration, les photos restantes sont reportées sans appel : le
   * service est indisponible pour toutes.
   */
  private async readEachAlone(photos: Readable[], now: Date, settled: Set<string>): Promise<void> {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let r;
      try {
        r = await this.withTimeout(this.vision.extractWineLabel(photo.data, MIME));
      } catch (e) {
        if (isDeferred(e)) {
          await this.settleFailure(photos.slice(i), e, now, settled);
          return;
        }
        await this.settleFailure([photo], e, now, settled);
        continue;
      }
      spend(photo, r.costCents);
      await this.done(photo, { raw: r.raw, model: r.model, latencyMs: r.latencyMs }, settled);
    }
  }

  /** Un appel bloqué devient une panne passagère (ETIMEDOUT) : le lot est reporté normalement. */
  private withTimeout<T>(call: Promise<T>): Promise<T> {
    const ms = this.callTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Délai de réponse de Gemini dépassé (ETIMEDOUT après ${Math.round(ms / 1000)} s)`)),
        ms,
      );
    });
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Panne passagère ou erreur de configuration (clé Gemini) : les photos
   * repartent en attente avec une attente croissante, puis échouent après
   * `EXTRACTION_ATTEMPTS` tentatives. Un report pour budget (plafond global ou
   * part de la cave) garde l'attente mais ne compte pas de tentative : il ne
   * mène jamais à l'échec. Autre erreur définitive : échec
   * immédiat, la saisie manuelle est proposée. Le texte brut de l'erreur ne va
   * que dans les logs ; la photo ne porte qu'un message en français.
   */
  private async settleFailure(photos: Reserved[], error: unknown, now: Date, settled: Set<string>): Promise<void> {
    const message = messageOf(error);
    const deferred = isDeferred(error);
    this.logger.warn(`Lot d'entrée de ${photos.length} photo(s) ${deferred ? 'reporté' : 'en échec'} : ${message}`);
    for (const photo of photos) {
      if (!deferred) {
        await this.fail(photo, UNREADABLE, settled);
        continue;
      }
      const reason = isConfigurationError(error) ? CONFIGURATION_DEFERRAL_REASON : deferralReason(error);
      if (error instanceof VisionBudgetExceededError) {
        // Plafond global ou part de la cave : aucun appel n'a eu lieu. La photo
        // ne consomme pas de tentative et ne passe jamais en échec ; elle est
        // reprise avec l'attente habituelle, dès que le budget le permet
        // (plafond ou part relevés, ou mois suivant).
        await this.prisma.photo.update({
          where: { id: photo.id },
          data: {
            status: 'PENDING',
            nextAttemptAt: new Date(now.getTime() + extractionBackoffDelay(photo.attempts + 1)),
            errorMessage: reason,
            ...costData(photo),
          },
        });
        settled.add(photo.id);
        continue;
      }
      const attempts = photo.attempts + 1;
      const exhausted = attempts >= EXTRACTION_ATTEMPTS;
      await this.prisma.photo.update({
        where: { id: photo.id },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          attempts,
          nextAttemptAt: exhausted ? null : new Date(now.getTime() + extractionBackoffDelay(attempts)),
          errorMessage: exhausted ? `${reason} — abandon après ${EXTRACTION_ATTEMPTS} tentatives` : reason,
          ...costData(photo),
        },
      });
      settled.add(photo.id);
    }
  }

  private async done(
    photo: Reserved,
    r: { raw: unknown; model: string; latencyMs: number },
    settled: Set<string>,
  ): Promise<void> {
    await this.prisma.photo.update({
      where: { id: photo.id },
      data: {
        status: 'DONE',
        rawExtraction: r.raw as Prisma.InputJsonValue,
        model: r.model,
        latencyMs: r.latencyMs,
        costCents: photo.costCents ?? 0,
        errorMessage: null,
        nextAttemptAt: null,
      },
    });
    settled.add(photo.id);
  }

  private async fail(photo: Reserved, errorMessage: string, settled: Set<string>): Promise<void> {
    await this.prisma.photo.update({
      where: { id: photo.id },
      data: { status: 'FAILED', errorMessage, nextAttemptAt: null, ...costData(photo) },
    });
    settled.add(photo.id);
  }
}

/** Ajoute une dépense à la photo : le coût cumulé de tous ses appels compte dans le plafond mensuel. */
function spend(photo: Reserved, cents: number): void {
  photo.costCents = (photo.costCents ?? 0) + cents;
}

function costData(photo: Reserved): { costCents?: number } {
  return photo.costCents === null ? {} : { costCents: photo.costCents };
}

/** Photo d'entrée : une panne passagère comme une erreur de configuration reporte l'analyse. */
function isDeferred(e: unknown): boolean {
  return isTransientVisionFailure(e) || isConfigurationError(e);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
