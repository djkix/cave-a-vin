import { statusFromMessage } from '../queue/transient-failure';
import { PAUSE_AFTER_REFUSAL } from '../vision/gemini-pause';

/** Nombre maximal de vins (accords) ou de domaines (descriptifs) envoyés à Gemini en un seul appel. */
export const GENERATION_BATCH_SIZE = 10;

/** Au-delà de cette attente, la plus ancienne demande part même si le lot est incomplet. */
export const GENERATION_BATCH_MAX_WAIT_MS = 2 * 60_000;

/** Intervalle entre deux passages du worker. */
export const GENERATION_BATCH_TICK_MS = 15_000;

/**
 * Échéance d'une réservation : une demande encore réservée au-delà (worker
 * arrêté en plein lot) est reprise au passage suivant, en comptant une tentative.
 */
export const GENERATION_RESERVATION_MS = 5 * 60_000;

/** Délai maximal d'un appel Gemini du lot, bien en deçà de l'échéance de réservation. */
export const GENERATION_CALL_TIMEOUT_MS = 2 * 60_000;

/**
 * Tentatives d'une demande (réponse inexploitable, absente du lot, panne,
 * configuration) avant l'échec. Une pause commune ou un report pour budget
 * n'en consomme jamais.
 */
export const GENERATION_MAX_ATTEMPTS = 5;

const FIRST_RETRY_MS = 5 * 60_000;

export interface GenerationCandidate {
  requestedAt: Date;
}

/**
 * Un lot part quand dix demandes sont prêtes, ou quand la plus ancienne
 * attend depuis 2 min : regrouper économise des appels, jamais au prix d'une
 * attente sans fin. Une demande reprise après un échec garde sa date de
 * demande : à son heure de reprise, elle part au passage suivant.
 */
export function shouldRunGeneration(candidates: GenerationCandidate[], now: Date): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length >= GENERATION_BATCH_SIZE) return true;
  const oldest = Math.min(...candidates.map((c) => c.requestedAt.getTime()));
  return oldest <= now.getTime() - GENERATION_BATCH_MAX_WAIT_MS;
}

/**
 * Attente avant la tentative suivante : 5 min, 20 min, 1 h 20, 5 h 20, soit
 * environ sept heures de patience avant l'échec. Après un refus de Google
 * (503, 429), jamais moins que la pause commune posée par ce refus.
 */
export function generationRetryDelay(attempts: number, error?: unknown): number {
  const base = FIRST_RETRY_MS * 4 ** Math.max(0, attempts - 1);
  const status = error instanceof Error ? statusFromMessage(error.message) : null;
  const pause = status === null ? undefined : PAUSE_AFTER_REFUSAL[status];
  return Math.max(base, pause?.ms ?? 0);
}
