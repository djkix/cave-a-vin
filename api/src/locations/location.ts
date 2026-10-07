import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Emplacement saisi (entrée, déplacement) : trois champs texte facultatifs. Les
 * longueurs et le « au moins un champ » sont vérifiés par normalizeLocation,
 * pour répondre avec les messages exacts de la spec.
 */
export const locationInputSchema = z.object(
  {
    zone: z.string({ invalid_type_error: 'Emplacement invalide' }).nullish(),
    casier: z.string({ invalid_type_error: 'Emplacement invalide' }).nullish(),
    position: z.string({ invalid_type_error: 'Emplacement invalide' }).nullish(),
  },
  { invalid_type_error: 'Emplacement invalide' },
);
export type LocationInput = z.infer<typeof locationInputSchema>;

/** Identifiant d'emplacement (sortie, inventaire, origine d'un déplacement) ; null = « Sans emplacement ». */
export const locationIdSchema = z.string({ invalid_type_error: 'Emplacement invalide' }).uuid('Emplacement invalide').nullable();

export interface LocationParts { zone: string | null; casier: string | null; position: string | null }
export interface NormalizedLocation extends LocationParts { labelKey: string }

/** Un endroit où se trouve un vin : un emplacement (id) ou « Sans emplacement » (id null). */
export interface Place { id: string | null; label: string; quantity: number }

export const NO_LOCATION = 'Sans emplacement';
export const MAX_LOCATION_FIELD = 40;
export const EMPTY_LOCATION = 'Indiquez au moins une zone, un casier ou une position';
export const LOCATION_TOO_LONG = '40 caractères au plus par champ d\'emplacement';
export const LOCATION_NOT_FOUND = 'Emplacement introuvable';
export const NOT_ENOUGH_AT_LOCATION = 'Pas assez de bouteilles à cet emplacement';
export const SAME_LOCATION = 'Emplacement d\'origine et de destination identiques';

/**
 * Champs nettoyés (espaces retirés, vide = absent) et clé d'unicité : les trois
 * champs en minuscules joints par `|`. « Cave 2 / B » et « cave 2 / b »
 * désignent donc le même emplacement.
 */
export function normalizeLocation(input: LocationInput): NormalizedLocation {
  const clean = (v: string | null | undefined) => {
    const t = (v ?? '').trim();
    if (t.length > MAX_LOCATION_FIELD) throw new BadRequestException(LOCATION_TOO_LONG);
    return t === '' ? null : t;
  };
  const zone = clean(input.zone);
  const casier = clean(input.casier);
  const position = clean(input.position);
  if (zone == null && casier == null && position == null) throw new BadRequestException(EMPTY_LOCATION);
  const labelKey = [zone, casier, position].map((p) => (p ?? '').toLowerCase()).join('|');
  return { zone, casier, position, labelKey };
}

/** « zone / casier / position », parties absentes omises. */
export function labelOf(loc: LocationParts): string {
  return [loc.zone, loc.casier, loc.position].filter((p): p is string => p != null && p !== '').join(' / ');
}

/**
 * Endroits d'un vin à partir des sommes de mouvements par emplacement (null =
 * mouvements sans emplacement). « Sans emplacement » = stock total − somme des
 * stocks positifs par emplacement, montré seulement s'il est positif.
 * Emplacements par libellé, « Sans emplacement » en dernier.
 */
export function placesOf(groups: Array<{ location: (LocationParts & { id: string }) | null; quantity: number }>): Place[] {
  const total = groups.reduce((s, g) => s + g.quantity, 0);
  const located = groups
    .filter((g): g is { location: LocationParts & { id: string }; quantity: number } => g.location != null && g.quantity > 0)
    .map((g) => ({ id: g.location.id, label: labelOf(g.location), quantity: g.quantity }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  const none = total - located.reduce((s, p) => s + p.quantity, 0);
  return none > 0 ? [...located, { id: null, label: NO_LOCATION, quantity: none }] : located;
}

/** Colonne « Emplacements » de l'export : « Cave 2 / B / 3 × 4 ; Sans emplacement × 2 ». */
export function formatPlaces(places: Place[]): string {
  return places.map((p) => `${p.label} × ${p.quantity}`).join(' ; ');
}
