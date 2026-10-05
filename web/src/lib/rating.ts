const ONE_DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const RANGE = 'La note doit être comprise entre 0 et 20';

export const formatRating = (value: number) => `${ONE_DECIMAL.format(value)} / 20`;
/** Forme courte, pour une ligne de liste ou un classement. */
export const formatRatingShort = (value: number) => `${ONE_DECIMAL.format(value)}/20`;

/** Note saisie : virgule ou point, de 0 à 20 par demi-point ; sinon le message à afficher. */
export function parseRating(text: string): number | string {
  const t = text.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d+)?$/.test(t)) return RANGE;
  const value = Number(t);
  if (value < 0 || value > 20) return RANGE;
  if (!Number.isInteger(value * 2)) return 'La note se donne par demi-point';
  return value;
}
