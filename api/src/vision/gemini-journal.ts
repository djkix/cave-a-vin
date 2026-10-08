import { PrismaClient } from '@prisma/client';
import { statusFromMessage } from '../queue/transient-failure';
import { GEMINI_PAUSE_REASON_KEY, GEMINI_PAUSE_UNTIL_KEY, GeminiPause, GeminiPausedError, PAUSE_AFTER_REFUSAL } from './gemini-pause';

export * from './gemini-pause';

/** Ce qui a demandé l'appel : une ligne de `gemini_call` par requête réellement envoyée à Google. */
export type GeminiUsage = 'LECTURE_ENTREE' | 'LECTURE_SORTIE' | 'ACCORDS' | 'DESCRIPTIF' | 'RECHERCHE_IMAGE';
export const GEMINI_USAGES: readonly GeminiUsage[] = ['LECTURE_ENTREE', 'LECTURE_SORTIE', 'ACCORDS', 'DESCRIPTIF', 'RECHERCHE_IMAGE'];

/** OK ; REFUSE = Google a répondu 429 ou 503 (compté par Google, non facturé) ; ERREUR = toute autre panne. */
export type GeminiOutcome = 'OK' | 'REFUSE' | 'ERREUR';

export interface GeminiCallRecord {
  usage: GeminiUsage;
  outcome: GeminiOutcome;
  httpStatus: number | null;
  reason: string | null;
  costCents: number;
  durationMs: number;
}

const REASON_MAX = 300;

/** Issue d'un appel en échec : refus de Google (429, 503) ou erreur ; coût porté par l'erreur s'il est connu. */
export function classifyFailure(error: unknown): Pick<GeminiCallRecord, 'outcome' | 'httpStatus' | 'reason' | 'costCents'> {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = statusFromMessage(message);
  const cost = (error as { costCents?: unknown } | null)?.costCents;
  return {
    outcome: httpStatus === 429 || httpStatus === 503 ? 'REFUSE' : 'ERREUR',
    httpStatus,
    reason: message.slice(0, REASON_MAX),
    costCents: typeof cost === 'number' && Number.isFinite(cost) ? cost : 0,
  };
}

type Log = { warn(message: string): void; error(message: string): void };

/**
 * Point de passage unique de tous les appels Gemini : il lit la pause commune
 * avant l'appel, note chaque requête envoyée et pose la pause après un refus.
 * Rien ici ne doit casser ni bloquer un appel : chaque écriture (et la lecture
 * de la pause) est protégée, une panne de la base n'est que journalisée.
 */
export class GeminiJournal {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Log = console,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Pause en cours, ou null (aucune, échue ou illisible). Lève si la base ne répond pas. */
  async currentPause(now = this.clock()): Promise<GeminiPause | null> {
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: [GEMINI_PAUSE_UNTIL_KEY, GEMINI_PAUSE_REASON_KEY] } } });
    const value = (key: string) => rows.find((r) => r.key === key)?.value ?? null;
    const until = new Date(value(GEMINI_PAUSE_UNTIL_KEY) ?? '');
    if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return null;
    return { until, reason: value(GEMINI_PAUSE_REASON_KEY) || 'refus de Google' };
  }

  /** Avant chaque appel : en pause, `GeminiPausedError` ; base injoignable, l'appel part quand même. */
  async assertNotPaused(now = this.clock()): Promise<void> {
    let pause: GeminiPause | null;
    try {
      pause = await this.currentPause(now);
    } catch (e) {
      this.log.error(`Pause Gemini illisible, appel envoyé : ${messageOf(e)}`);
      return;
    }
    if (pause) throw new GeminiPausedError(pause.until, pause.reason);
  }

  /** Une ligne par requête envoyée ; un refus pose aussi la pause commune. */
  async record(call: GeminiCallRecord, now = this.clock()): Promise<void> {
    try {
      await this.prisma.geminiCall.create({ data: call });
    } catch (e) {
      this.log.error(`Journal des appels Gemini : écriture impossible : ${messageOf(e)}`);
    }
    if (call.outcome === 'REFUSE' && call.httpStatus !== null) await this.extendPause(call.httpStatus, now);
  }

  /**
   * 503 : 5 min ; 429 : 1 h. Jamais de raccourcissement : la plus lointaine
   * échéance l'emporte. La ligne est créée si besoin (ON CONFLICT DO NOTHING :
   * sans conflit possible), puis verrouillée (FOR UPDATE) le temps de comparer et d'écrire
   * l'échéance et son motif : deux refus simultanés s'exécutent l'un après
   * l'autre et le motif correspond toujours à l'échéance gardée.
   */
  async extendPause(httpStatus: number, now = this.clock()): Promise<void> {
    const pause = PAUSE_AFTER_REFUSAL[httpStatus];
    if (!pause) return;
    const until = new Date(now.getTime() + pause.ms);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO app_setting (key, value) VALUES (${GEMINI_PAUSE_UNTIL_KEY}, '') ON CONFLICT (key) DO NOTHING`;
        const [row] = await tx.$queryRaw<Array<{ value: string }>>`SELECT value FROM app_setting WHERE key = ${GEMINI_PAUSE_UNTIL_KEY} FOR UPDATE`;
        const current = new Date(row?.value ?? '');
        if (!Number.isNaN(current.getTime()) && current.getTime() >= until.getTime()) return;
        await tx.appSetting.update({ where: { key: GEMINI_PAUSE_UNTIL_KEY }, data: { value: until.toISOString() } });
        await tx.appSetting.upsert({
          where: { key: GEMINI_PAUSE_REASON_KEY },
          create: { key: GEMINI_PAUSE_REASON_KEY, value: pause.reason },
          update: { value: pause.reason },
        });
      });
      this.log.warn(`Gemini a refusé l'appel (${httpStatus}) : pause jusqu'à au moins ${until.toISOString()}`);
    } catch (e) {
      this.log.error(`Pause Gemini impossible à poser : ${messageOf(e)}`);
    }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
