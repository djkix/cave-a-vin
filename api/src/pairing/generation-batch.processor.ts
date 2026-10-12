import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { splitCost } from '../queue/entry-batch';
import { MAX_DELAY_MS } from '../queue/extraction.queue';
import { deferralReason, isConfigurationError } from '../queue/transient-failure';
import { PAIRING_BUDGET_SHARE, VisionBudgetExceededError, VisionBudgetService } from '../queue/vision-budget.service';
import { GeminiPause, GeminiPausedError } from '../vision/gemini-pause';
import {
  GENERATION_BATCH_SIZE,
  GENERATION_CALL_TIMEOUT_MS,
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RESERVATION_MS,
  generationRetryDelay,
  shouldRunGeneration,
} from './generation-batch';

/** Message final d'une demande dont les réponses restent inexploitables (inchangé depuis l'appel par vin). */
export const INVALID_ANSWER = 'Réponse de Gemini inexploitable';
/** Message final d'une erreur de configuration (clé refusée, droits). */
export const CONFIGURATION_FAILURE = 'Génération impossible : configuration Gemini à vérifier';
/** Une demande absente de la réponse du lot (ou invalide) : traitée comme une sortie inexploitable. */
export const MISSING_FROM_BATCH = 'Sortie du modèle invalide (réponse absente ou invalide dans le lot)';
/** Message d'une demande reprise après un arrêt du worker en plein lot, à la dernière tentative. */
export const INTERRUPTED = `Génération interrompue (worker arrêté en plein lot) — abandon après ${GENERATION_MAX_ATTEMPTS} tentatives`;

/** Demande réservée par un lot. */
export interface ReservedRequest {
  id: string;
  attempts: number;
}

type Status = 'PENDING' | 'FAILED';

/** Le sous-ensemble des écritures Prisma commun à `pairing` et `producer_profile`. */
export interface QueueWhere {
  id?: string | { in: string[] };
  status?: 'PENDING';
  source?: string;
  reservedUntil?: Date | null | { lte: Date };
  attempts?: { gte: number } | { lt: number };
  requestedAt?: { lte: Date };
  OR?: QueueWhere[];
  nextAttemptAt?: Date | null | { lte: Date };
}

export interface QueueData {
  status?: Status;
  attempts?: number | { increment: number };
  nextAttemptAt?: Date | null;
  reservedUntil?: Date | null;
  errorMessage?: string | null;
}

/** `pairing` ou `producer_profile`, vus comme une file. */
export interface QueueTable {
  findMany(args: { where: QueueWhere; orderBy: { requestedAt: 'asc' }; take: number; select: { requestedAt: true } }): Promise<Array<{ requestedAt: Date }>>;
  updateMany(args: { where: QueueWhere; data: QueueData }): Promise<{ count: number }>;
}

export interface PauseReader {
  currentPause(now?: Date): Promise<GeminiPause | null>;
}

/** Réponse d'un lot : une entrée par demande valide, `index` = sa position dans l'appel. */
export interface BatchAnswer<Out> {
  items: Array<Out & { index: number }>;
  model: string;
  costCents: number;
}

/** Ce que le lot sait d'une demande prête à partir : sa ligne et ce qu'on envoie à Gemini. */
export interface Prepared<Input> {
  request: ReservedRequest;
  input: Input;
}

/**
 * Accords et descriptifs de domaine par lots : la table sert de file, comme
 * `photo` pour les photos d'entrée (voir EntryBatchProcessor). Chaque passage
 * reprend les réservations échues, attend s'il le faut (moins de dix demandes,
 * toutes de moins de 2 min), réserve au plus dix demandes et les fait générer
 * en un seul appel Gemini.
 *
 * Aucune exception ne sort de `tick` : une demande réservée finit toujours
 * générée, en échec ou de nouveau en attente, et au pire sa réservation expire
 * et elle est reprise. Une demande reste PENDING pendant tout son passage dans
 * la file : l'interface affiche « en préparation ».
 */
export abstract class GenerationBatchProcessor<Input, Out> {
  protected abstract readonly logger: Logger;
  /** « Accords », « Descriptifs » : pour les logs. */
  protected abstract readonly label: string;
  /** Nom SQL de la table (constante, jamais une saisie). */
  protected abstract readonly tableName: 'pairing' | 'producer_profile';
  /** Condition propre à la table, ajoutée à toute lecture ou écriture de la file. */
  protected readonly scope: QueueWhere = {};
  protected readonly scopeSql: Prisma.Sql = Prisma.empty;

  /** Délai maximal d'un appel Gemini ; modifiable par les tests. */
  callTimeoutMs = GENERATION_CALL_TIMEOUT_MS;

  constructor(
    protected readonly prisma: PrismaService,
    private readonly budget: Pick<VisionBudgetService, 'assertUnderShare'>,
    private readonly pause: PauseReader,
  ) {}

  protected abstract table(db?: Prisma.TransactionClient): QueueTable;

  /**
   * Ce qu'il faut envoyer pour chaque demande réservée, dans l'ordre. Une
   * demande devenue sans objet (domaine sans plus aucun vin) est réglée ici
   * et absente du résultat.
   */
  protected abstract prepare(requests: ReservedRequest[], deadline: Date): Promise<Array<Prepared<Input>>>;

  protected abstract generate(inputs: Input[]): Promise<BatchAnswer<Out>>;

  /** Enregistre une réponse valide ; `costCents` : part du coût de l'appel. */
  protected abstract save(request: ReservedRequest, item: Out, meta: { model: string; costCents: number }, deadline: Date): Promise<void>;

  /**
   * Pendant une pause commune de Gemini, le passage ne réserve rien (seules
   * les réservations échues sont reprises, sans appel). Au plus un appel
   * Gemini par passage.
   */
  async tick(now = new Date()): Promise<{ processed: number }> {
    try {
      await this.reclaimExpired(now);
      if (await this.pause.currentPause(now)) return { processed: 0 };
    } catch (e) {
      this.logger.error(`${this.label} par lot : préparation impossible : ${messageOf(e)}`);
      return { processed: 0 };
    }
    let reserved: { requests: ReservedRequest[]; deadline: Date } | null;
    try {
      const candidates = await this.table().findMany({
        where: this.readyWhere(now),
        orderBy: { requestedAt: 'asc' },
        take: GENERATION_BATCH_SIZE,
        select: { requestedAt: true },
      });
      if (!shouldRunGeneration(candidates, now)) return { processed: 0 };
      reserved = await this.reserve(now);
    } catch (e) {
      this.logger.error(`${this.label} par lot : préparation impossible : ${messageOf(e)}`);
      return { processed: 0 };
    }
    if (!reserved) return { processed: 0 };
    await this.runBatch(reserved.requests, now, reserved.deadline);
    return { processed: reserved.requests.length };
  }

  /** Prête : en attente, non réservée, à son heure de reprise, demandée au plus tard maintenant. */
  private readyWhere(now: Date): QueueWhere {
    return {
      ...this.scope,
      status: 'PENDING',
      reservedUntil: null,
      requestedAt: { lte: now },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    };
  }

  /**
   * Une demande encore réservée après l'échéance (worker arrêté en plein lot)
   * revient dans la file. La reprise compte comme une tentative : une demande
   * qui fait tomber le worker finit en échec au lieu de tourner sans fin.
   */
  private async reclaimExpired(now: Date): Promise<void> {
    const stuck: QueueWhere = { ...this.scope, status: 'PENDING', reservedUntil: { lte: now } };
    const abandoned = await this.table().updateMany({
      where: { ...stuck, attempts: { gte: GENERATION_MAX_ATTEMPTS - 1 } },
      data: { status: 'FAILED', attempts: { increment: 1 }, reservedUntil: null, nextAttemptAt: null, errorMessage: INTERRUPTED },
    });
    const requeued = await this.table().updateMany({
      where: { ...stuck, attempts: { lt: GENERATION_MAX_ATTEMPTS - 1 } },
      data: { attempts: { increment: 1 }, reservedUntil: null },
    });
    if (requeued.count + abandoned.count > 0) {
      this.logger.warn(`${this.label} bloqués en plein lot : ${requeued.count} remis en file, ${abandoned.count} abandonné(s)`);
    }
  }

  /**
   * `FOR UPDATE SKIP LOCKED` : deux passages simultanés (deux workers) ne
   * réservent jamais la même demande ; une demande réservée porte une
   * échéance et n'est plus prête. Dates comparées en UTC, comme Prisma les
   * écrit, quel que soit le fuseau de la session PostgreSQL.
   */
  private async reserve(now: Date): Promise<{ requests: ReservedRequest[]; deadline: Date } | null> {
    const deadline = new Date(now.getTime() + GENERATION_RESERVATION_MS);
    const table = Prisma.raw(`"${this.tableName}"`);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ReservedRequest[]>`
        SELECT id, attempts FROM ${table}
        WHERE status = 'PENDING' AND reserved_until IS NULL
          AND requested_at <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND (next_attempt_at IS NULL OR next_attempt_at <= (${now}::timestamptz AT TIME ZONE 'UTC'))
          ${this.scopeSql}
        ORDER BY requested_at
        LIMIT ${GENERATION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return null;
      await this.table(tx).updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { reservedUntil: deadline } });
      return { requests: rows.map((r) => ({ id: r.id, attempts: Number(r.attempts) })), deadline };
    });
  }

  /** Traite un lot réservé sans jamais laisser sortir d'exception. */
  private async runBatch(requests: ReservedRequest[], now: Date, deadline: Date): Promise<void> {
    const settled = new Set<string>();
    try {
      await this.processBatch(requests, now, deadline, settled);
    } catch (e) {
      // Erreur imprévue (écriture en base, bogue) : les demandes encore réservées
      // reviennent en attente (une tentative) plutôt que d'attendre l'échéance.
      this.logger.error(`${this.label} : lot interrompu : ${messageOf(e)}`);
      try {
        await this.settleFailure(requests.filter((r) => !settled.has(r.id)), e, now, deadline, settled);
      } catch (e2) {
        this.logger.error(`${this.label} : remise en attente impossible, reprise à l'échéance : ${messageOf(e2)}`);
      }
    }
  }

  private async processBatch(requests: ReservedRequest[], now: Date, deadline: Date, settled: Set<string>): Promise<void> {
    // Plafond des accords et descriptifs vérifié une fois par lot, avant tout appel.
    try {
      await this.budget.assertUnderShare(PAIRING_BUDGET_SHARE);
    } catch (e) {
      await this.settleFailure(requests, e, now, deadline, settled);
      return;
    }
    const prepared = await this.prepare(requests, deadline);
    requests.filter((r) => !prepared.some((p) => p.request.id === r.id)).forEach((r) => settled.add(r.id));
    if (prepared.length === 0) return;

    let answer: BatchAnswer<Out>;
    try {
      answer = await this.withTimeout(this.generate(prepared.map((p) => p.input)));
    } catch (e) {
      await this.settleFailure(prepared.map((p) => p.request), e, now, deadline, settled);
      return;
    }

    const costCents = splitCost(answer.costCents, prepared.length);
    const byIndex = new Map(answer.items.map((item) => [item.index, item]));
    const missing: ReservedRequest[] = [];
    for (const [index, { request }] of prepared.entries()) {
      const item = byIndex.get(index);
      if (!item) {
        missing.push(request);
        continue;
      }
      await this.save(request, item, { model: answer.model, costCents }, deadline);
      settled.add(request.id);
    }
    if (missing.length) await this.settleFailure(missing, new Error(MISSING_FROM_BATCH), now, deadline, settled);
    this.logger.log(`${this.label} : lot de ${prepared.length}, ${prepared.length - missing.length} enregistré(s)`);
  }

  /** Un appel bloqué devient une panne passagère (ETIMEDOUT) : le lot est reporté normalement. */
  private withTimeout<T>(call: Promise<T>): Promise<T> {
    const ms = this.callTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Délai de réponse de Gemini dépassé (ETIMEDOUT après ${Math.round(ms / 1000)} s)`)), ms);
    });
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Pause commune ou plafond atteint : aucun appel n'est parti. La demande
   * revient en attente avec le message de la pause (ou du report), reprise à
   * la fin de la pause (ou après l'attente maximale pour le budget), sans
   * consommer de tentative : jamais d'échec pour cette raison.
   *
   * Toute autre erreur (réponse inexploitable, demande absente du lot, panne,
   * configuration) consomme une tentative, avec une attente d'au moins 5 min ;
   * à la cinquième, la demande passe en échec avec le message habituel.
   */
  private async settleFailure(requests: ReservedRequest[], error: unknown, now: Date, deadline: Date, settled: Set<string>): Promise<void> {
    if (requests.length === 0) return;
    this.logger.warn(`${this.label} : ${requests.length} demande(s) reportée(s) : ${messageOf(error)}`);
    for (const request of requests) {
      if (error instanceof GeminiPausedError || error instanceof VisionBudgetExceededError) {
        await this.write(request, deadline, {
          status: 'PENDING',
          reservedUntil: null,
          nextAttemptAt: error instanceof GeminiPausedError ? error.until : new Date(now.getTime() + MAX_DELAY_MS),
          errorMessage: deferralReason(error),
        });
      } else {
        const attempts = request.attempts + 1;
        const exhausted = attempts >= GENERATION_MAX_ATTEMPTS;
        await this.write(request, deadline, {
          status: exhausted ? 'FAILED' : 'PENDING',
          attempts,
          reservedUntil: null,
          nextAttemptAt: exhausted ? null : new Date(now.getTime() + generationRetryDelay(attempts, error)),
          errorMessage: exhausted ? finalReason(error) : retryReason(error),
        });
      }
      settled.add(request.id);
    }
  }

  /**
   * Écriture réservée au lot qui tient la demande : une demande reprise par un
   * autre passage après l'échéance n'est jamais écrasée par celui-ci.
   */
  protected write(request: ReservedRequest, deadline: Date, data: QueueData): Promise<{ count: number }> {
    return this.table().updateMany({ where: { ...this.scope, id: request.id, reservedUntil: deadline }, data });
  }
}

function isInvalidAnswer(e: unknown): boolean {
  return e instanceof Error && e.message.includes('Sortie du modèle invalide');
}

/** Message affiché pendant l'attente de la tentative suivante. */
function retryReason(e: unknown): string {
  if (isInvalidAnswer(e)) return `${INVALID_ANSWER}, nouvel essai automatique`;
  if (isConfigurationError(e)) return 'Génération reportée : configuration Gemini à vérifier, reprise automatique';
  return deferralReason(e);
}

/** Messages d'échec de l'appel par vin, inchangés. */
function finalReason(e: unknown): string {
  if (isInvalidAnswer(e)) return INVALID_ANSWER;
  if (isConfigurationError(e)) return CONFIGURATION_FAILURE;
  return `${deferralReason(e)} — abandon`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
