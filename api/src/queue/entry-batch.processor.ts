import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PhotosService } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { VisionBatchMismatchError } from '../vision/gemini-vision.provider';
import { VISION_PROVIDER, VisionProvider } from '../vision/vision-provider.interface';
import { ENTRY_BATCH_SIZE, ENTRY_CANDIDATES_SCAN, RESERVATION_MS, shouldRun, splitCost } from './entry-batch';
import { EXTRACTION_ATTEMPTS, extractionBackoffDelay } from './extraction.queue';
import { deferralReason, isTransientVisionFailure } from './transient-failure';
import { VisionBudgetService } from './vision-budget.service';

interface Reserved {
  id: string;
  attempts: number;
}

const MIME = 'image/jpeg';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async tick(now = new Date()): Promise<{ processed: number }> {
    let reserved: Reserved[];
    try {
      await this.reclaimExpired(now);
      const candidates = await this.prisma.photo.findMany({
        where: this.candidateWhere(now),
        orderBy: { createdAt: 'asc' },
        take: ENTRY_CANDIDATES_SCAN,
        select: { createdAt: true, nextAttemptAt: true },
      });
      if (!shouldRun(candidates, now)) return { processed: 0 };
      reserved = await this.reserve(now);
    } catch (e) {
      this.logger.error(`Lot d'entrée : préparation impossible : ${messageOf(e)}`);
      return { processed: 0 };
    }
    if (reserved.length === 0) return { processed: 0 };

    const settled = new Set<string>();
    try {
      await this.processBatch(reserved, now, settled);
    } catch (e) {
      // Erreur imprévue (écriture en base, bogue) : les photos encore réservées
      // reviennent en attente plutôt que de rester PROCESSING jusqu'à l'échéance.
      this.logger.error(`Lot d'entrée interrompu : ${messageOf(e)}`);
      const rest = reserved.filter((p) => !settled.has(p.id));
      try {
        await this.settleFailure(rest, e, now, settled);
      } catch (e2) {
        this.logger.error(`Lot d'entrée : remise en attente impossible, reprise à l'échéance : ${messageOf(e2)}`);
      }
    }
    return { processed: reserved.length };
  }

  private candidateWhere(now: Date): Prisma.PhotoWhereInput {
    return {
      purpose: 'ENTRY',
      status: 'PENDING',
      dismissedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    };
  }

  /** Worker arrêté en plein lot : la réservation échue rend la photo à la file. */
  private async reclaimExpired(now: Date): Promise<void> {
    const { count } = await this.prisma.photo.updateMany({
      where: { purpose: 'ENTRY', status: 'PROCESSING', nextAttemptAt: { lte: now } },
      data: { status: 'PENDING', nextAttemptAt: null },
    });
    if (count > 0) this.logger.warn(`${count} photo(s) d'entrée reprise(s) après une réservation échue`);
  }

  /**
   * `FOR UPDATE SKIP LOCKED` : deux passages simultanés (deux workers) ne
   * réservent jamais la même photo. Les dates sont comparées en UTC, comme Prisma
   * les écrit, quel que soit le fuseau de la session PostgreSQL.
   */
  private async reserve(now: Date): Promise<Reserved[]> {
    const deadline = new Date(now.getTime() + RESERVATION_MS);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Reserved[]>`
        SELECT id, attempts FROM photo
        WHERE purpose = 'ENTRY' AND status = 'PENDING' AND dismissed_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= (${now}::timestamptz AT TIME ZONE 'UTC'))
        ORDER BY created_at
        LIMIT ${ENTRY_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      await tx.photo.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: 'PROCESSING', nextAttemptAt: deadline },
      });
      return rows.map((r) => ({ id: r.id, attempts: Number(r.attempts) }));
    });
  }

  private async processBatch(reserved: Reserved[], now: Date, settled: Set<string>): Promise<void> {
    try {
      await this.budget.assertUnderCap();
    } catch (e) {
      await this.settleFailure(reserved, e, now, settled);
      return;
    }

    const readable: Array<Reserved & { data: Buffer }> = [];
    for (const photo of reserved) {
      try {
        readable.push({ ...photo, data: await this.photos.readNormalized(photo.id) });
      } catch (e) {
        this.logger.warn(`Photo d'entrée ${photo.id} : image illisible : ${messageOf(e)}`);
        await this.fail(photo.id, 'Image introuvable', settled);
      }
    }
    if (readable.length === 0) return;

    let batch;
    try {
      batch = await this.vision.extractWineLabels(readable.map((p) => ({ data: p.data, mimeType: MIME })));
    } catch (e) {
      if (e instanceof VisionBatchMismatchError) {
        this.logger.warn(`Lot mélangé (${messageOf(e)}) : relecture photo par photo`);
        for (const photo of readable) await this.readAlone(photo, now, settled);
        return;
      }
      await this.settleFailure(readable, e, now, settled);
      return;
    }

    const cost = splitCost(batch.costCents, readable.length);
    for (let i = 0; i < readable.length; i++) {
      const item = batch.items[i];
      const id = readable[i].id;
      if (!item || 'error' in item) {
        await this.fail(id, item?.error ?? 'Lecture de l’étiquette inexploitable', settled);
        continue;
      }
      await this.done(id, { raw: item.raw, model: batch.model, latencyMs: batch.latencyMs, costCents: cost }, settled);
    }
    this.logger.log(`Lot d'entrée de ${readable.length} photo(s) lu en ${batch.latencyMs} ms`);
  }

  /** Lot mélangé : chaque photo est relue seule, aucune lecture ne peut être attribuée à une autre. */
  private async readAlone(photo: Reserved & { data: Buffer }, now: Date, settled: Set<string>): Promise<void> {
    let r;
    try {
      r = await this.vision.extractWineLabel(photo.data, MIME);
    } catch (e) {
      await this.settleFailure([photo], e, now, settled);
      return;
    }
    await this.done(photo.id, { raw: r.raw, model: r.model, latencyMs: r.latencyMs, costCents: r.costCents }, settled);
  }

  /**
   * Panne passagère (plafond compris) : les photos repartent en attente avec une
   * attente croissante, puis échouent après `EXTRACTION_ATTEMPTS` tentatives.
   * Erreur définitive : échec immédiat, la saisie manuelle est proposée.
   */
  private async settleFailure(photos: Reserved[], error: unknown, now: Date, settled: Set<string>): Promise<void> {
    const message = messageOf(error);
    const transient = isTransientVisionFailure(error);
    this.logger.warn(`Lot d'entrée de ${photos.length} photo(s) ${transient ? 'reporté' : 'en échec'} : ${message}`);
    for (const photo of photos) {
      if (!transient) {
        await this.fail(photo.id, message, settled);
        continue;
      }
      const attempts = photo.attempts + 1;
      const reason = deferralReason(error);
      if (attempts >= EXTRACTION_ATTEMPTS) {
        await this.prisma.photo.update({
          where: { id: photo.id },
          data: {
            status: 'FAILED',
            attempts,
            nextAttemptAt: null,
            errorMessage: `${reason} — abandon après ${EXTRACTION_ATTEMPTS} tentatives`,
          },
        });
      } else {
        await this.prisma.photo.update({
          where: { id: photo.id },
          data: {
            status: 'PENDING',
            attempts,
            nextAttemptAt: new Date(now.getTime() + extractionBackoffDelay(attempts)),
            errorMessage: reason,
          },
        });
      }
      settled.add(photo.id);
    }
  }

  private async done(
    id: string,
    r: { raw: unknown; model: string; latencyMs: number; costCents: number },
    settled: Set<string>,
  ): Promise<void> {
    await this.prisma.photo.update({
      where: { id },
      data: {
        status: 'DONE',
        rawExtraction: r.raw as Prisma.InputJsonValue,
        model: r.model,
        latencyMs: r.latencyMs,
        costCents: r.costCents,
        errorMessage: null,
        nextAttemptAt: null,
      },
    });
    settled.add(id);
  }

  private async fail(id: string, errorMessage: string, settled: Set<string>): Promise<void> {
    await this.prisma.photo.update({ where: { id }, data: { status: 'FAILED', errorMessage, nextAttemptAt: null } });
    settled.add(id);
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
