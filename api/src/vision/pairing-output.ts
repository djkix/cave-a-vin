import { normalizeLabel } from '../appellations/appellations.service';

export const MAX_DISHES = 8;
export const MAX_DISH_LENGTH = 60;

/**
 * Réponse de Gemini inexploitable. Le message commence par « Sortie du modèle
 * invalide » : `isTransientVisionFailure` la classe en échec définitif, et la
 * file ne la rejoue pas.
 */
export class PairingInvalidOutputError extends Error {
  /** `costCents` : l'appel a abouti et il est facturé même si sa sortie est inexploitable (posé par le fournisseur). */
  constructor(message: string, readonly costCents = 0) {
    super(message);
  }
}

const invalid = (why: string) => new PairingInvalidOutputError(`Sortie du modèle invalide : ${why}`);

/** Plats suggérés : 1 à 8 libellés non vides de 60 caractères au plus, sans doublons. */
export function parsePairingOutput(raw: unknown): string[] {
  const plats = raw && typeof raw === 'object' ? (raw as { plats?: unknown }).plats : undefined;
  if (!Array.isArray(plats)) throw invalid('champ « plats » absent');
  const seen = new Set<string>();
  const dishes: string[] = [];
  for (const p of plats) {
    if (typeof p !== 'string') throw invalid('plat non textuel');
    const dish = p.trim().replace(/\s+/g, ' ');
    if (!dish) throw invalid('plat vide');
    if (dish.length > MAX_DISH_LENGTH) throw invalid('plat trop long');
    const key = normalizeLabel(dish);
    if (seen.has(key)) continue;
    seen.add(key);
    dishes.push(dish);
  }
  if (dishes.length === 0 || dishes.length > MAX_DISHES) throw invalid(`${dishes.length} plats`);
  return dishes;
}
