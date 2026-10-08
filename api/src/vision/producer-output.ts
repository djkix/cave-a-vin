export const MIN_PRODUCER_DESCRIPTION = 40;
export const MAX_PRODUCER_DESCRIPTION = 1200;

/**
 * Réponse de Gemini inexploitable pour un descriptif de domaine. Le message
 * commence par « Sortie du modèle invalide » : `isTransientVisionFailure` la
 * classe en échec définitif, et la file ne la rejoue pas.
 */
export class ProducerInvalidOutputError extends Error {
  /** `costCents` : l'appel a abouti et il est facturé même si sa sortie est inexploitable (posé par le fournisseur). */
  constructor(message: string, readonly costCents = 0) {
    super(message);
  }
}

const invalid = (why: string) => new ProducerInvalidOutputError(`Sortie du modèle invalide : ${why}`);

export type ProducerOutput = { known: true; description: string } | { known: false };

/** `{"connu": false}` ou `{"connu": true, "description": …}` de 40 à 1200 caractères après rognage. */
export function parseProducerOutput(raw: unknown): ProducerOutput {
  if (!raw || typeof raw !== 'object') throw invalid('réponse non objet');
  const { connu, description } = raw as { connu?: unknown; description?: unknown };
  if (connu === false) return { known: false };
  if (connu !== true) throw invalid('champ « connu » absent');
  if (typeof description !== 'string') throw invalid('descriptif absent');
  const text = description.trim();
  if (text.length < MIN_PRODUCER_DESCRIPTION) throw invalid('descriptif trop court');
  if (text.length > MAX_PRODUCER_DESCRIPTION) throw invalid('descriptif trop long');
  return { known: true, description: text };
}
