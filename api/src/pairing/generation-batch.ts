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
 * Tentatives d'une demande dont la réponse est inexploitable (absente ou
 * invalide dans le lot, lot mélangé) ou dont le lot a été interrompu, avant
 * l'échec. Une panne, une erreur de configuration, une pause commune ou un
 * report pour budget n'en consomment jamais.
 */
export const GENERATION_MAX_ATTEMPTS = 5;

/** Panne ou configuration : une demande plus ancienne que cela passe en échec. */
export const GENERATION_GIVE_UP_MS = 7 * 24 * 60 * 60_000;

const FIRST_RETRY_MS = 5 * 60_000;
const MAX_TRANSIENT_RETRY_MS = 6 * 60 * 60_000;

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

/** Réponse inexploitable : 5 min, 20 min, 1 h 20, 5 h 20 avant la tentative suivante. */
export function invalidAnswerRetryDelay(attempts: number): number {
  return FIRST_RETRY_MS * 4 ** Math.max(0, attempts - 1);
}

/**
 * Panne ou configuration : attendre aussi longtemps que la demande attend
 * déjà, entre 5 min et 6 h — une panne longue espace les essais sans jamais
 * les arrêter avant 7 jours. Après un refus de Google (503, 429), jamais avant
 * la fin de la pause commune qu'il a posée.
 */
export function transientRetryDelay(requestedAt: Date, now: Date, error?: unknown): number {
  const age = now.getTime() - requestedAt.getTime();
  const base = Math.min(Math.max(age, FIRST_RETRY_MS), MAX_TRANSIENT_RETRY_MS);
  const status = error instanceof Error ? statusFromMessage(error.message) : null;
  const pause = status === null ? undefined : PAUSE_AFTER_REFUSAL[status];
  return Math.max(base, pause?.ms ?? 0);
}
