import { STATS_TIME_ZONE } from '../stats/stats';

/** Réglages `app_setting` de la pause commune à l'api et au worker. */
export const GEMINI_PAUSE_UNTIL_KEY = 'gemini_pause_until';
export const GEMINI_PAUSE_REASON_KEY = 'gemini_pause_reason';

/** Après un 503 : le modèle est saturé pour quelques minutes. */
export const SATURATION_PAUSE_MS = 5 * 60_000;
/** Après un 429 : le quota de la clé est épuisé, inutile de revenir avant une heure. */
export const QUOTA_PAUSE_MS = 60 * 60_000;

/** Durée et motif de la pause posée après un refus de Google, par statut HTTP. */
export const PAUSE_AFTER_REFUSAL: Record<number, { ms: number; reason: string }> = {
  503: { ms: SATURATION_PAUSE_MS, reason: 'modèle saturé' },
  429: { ms: QUOTA_PAUSE_MS, reason: 'quota épuisé' },
};

const parisTime = new Intl.DateTimeFormat('fr-FR', { timeZone: STATS_TIME_ZONE, hour: '2-digit', minute: '2-digit' });

export function pauseMessage(until: Date, reason: string): string {
  return `Gemini en pause jusqu'à ${parisTime.format(until)} (${reason})`;
}

/**
 * Gemini est en pause commune : aucun appel n'a été envoyé à Google. Toujours
 * passagère (la photo n'est jamais perdue) ; `until` dit quand reprendre.
 */
export class GeminiPausedError extends Error {
  constructor(
    readonly until: Date,
    readonly reason: string,
  ) {
    super(pauseMessage(until, reason));
    this.name = 'GeminiPausedError';
  }
}

export interface GeminiPause {
  until: Date;
  reason: string;
}

