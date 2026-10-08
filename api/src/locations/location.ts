import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Emplacement saisi (entrée, déplacement, inventaire) : une zone de la liste de
 * la cave (`zoneId`, null = « Sans zone ») et deux champs texte facultatifs.
 * Les longueurs et le « au moins un champ » sont vérifiés par
 * normalizeLocation, pour répondre avec les messages exacts de la spec.
 *
 * Compatibilité : une PWA restée en cache envoie encore `zone` en texte ; il est
 * rapproché de la zone de même nom (sans espaces autour ni casse), créée au
 * besoin en fin de liste (LocationsService.resolve).
 */
export const locationInputSchema = z.object(
  {
    zoneId: z.string({ invalid_type_error: 'Emplacement invalide' }).uuid('Emplacement invalide').nullish(),
    zone: z.string({ invalid_type_error: 'Emplacement invalide' }).nullish(),
    casier: z.string({ invalid_type_error: 'Emplacement invalide' }).nullish(),
    position: z.string({ invalid_type_error: 'Emplacement invalide' }).nullish(),
  },
  { invalid_type_error: 'Emplacement invalide' },
);
export type LocationInput = z.infer<typeof locationInputSchema>;

/** Identifiant d'emplacement (sortie, inventaire, origine d'un déplacement) ; null = « Sans emplacement ». */
export const locationIdSchema = z.string({ invalid_type_error: 'Emplacement invalide' }).uuid('Emplacement invalide').nullable();

/** Parties d'un libellé : `zone` est le NOM de la zone, lu par la relation (il suit les renommages). */
export interface LocationParts { zone: string | null; casier: string | null; position: string | null }
/** Emplacement lu, prêt pour un libellé : son id, celui de sa zone et ses parties. */
export interface LocatedParts extends LocationParts { id: string; zoneId: string | null }
/** Saisie nettoyée : `zoneName` seulement pour un ancien client qui envoie `zone` en texte. */
export interface NormalizedLocation { zoneId: string | null; zoneName: string | null; casier: string | null; position: string | null }

/** Un endroit où se trouve un vin : un emplacement (id) ou « Sans emplacement » (id null) ; `zoneId` : sa zone (indication, photo). */
export interface Place { id: string | null; label: string; quantity: number; zoneId: string | null }

export const NO_LOCATION = 'Sans emplacement';
export const MAX_LOCATION_FIELD = 40;
export const EMPTY_LOCATION = 'Indiquez au moins une zone, un casier ou une position';
export const LOCATION_TOO_LONG = '40 caractères au plus par champ d\'emplacement';
export const LOCATION_NOT_FOUND = 'Emplacement introuvable';
export const NOT_ENOUGH_AT_LOCATION = 'Pas assez de bouteilles à cet emplacement';
export const SAME_LOCATION = 'Emplacement d\'origine et de destination identiques';
export const CANCEL_MOVED = 'Impossible d’annuler : ces bouteilles ne sont plus à cet emplacement (déplacées ou sorties depuis)';

/**
 * Champs nettoyés (espaces retirés, vide = absent). L'unicité d'un emplacement
 * — (cave, zone, casier et position en minuscules) — est tenue par l'index
 * location_place_key de la base, seul endroit où elle est calculée : « B » et
 * « b » dans la même zone désignent donc le même emplacement.
 */
export function normalizeLocation(input: LocationInput): NormalizedLocation {
  const clean = (v: string | null | undefined) => {
    const t = (v ?? '').trim();
    if (t.length > MAX_LOCATION_FIELD) throw new BadRequestException(LOCATION_TOO_LONG);
    return t === '' ? null : t;
  };
  const zoneId = input.zoneId ?? null;
  const zoneName = clean(input.zone);
  const casier = clean(input.casier);
  const position = clean(input.position);
  if (zoneId == null && zoneName == null && casier == null && position == null) throw new BadRequestException(EMPTY_LOCATION);
  return { zoneId, zoneName: zoneId ? null : zoneName, casier, position };
}

/** Emplacement lu avec sa zone (`include: { zone: true }`) → parties du libellé. */
export function partsOf(l: { id: string; zoneId: string | null; zone: { name: string } | null; casier: string | null; position: string | null }): LocatedParts {
  return { id: l.id, zoneId: l.zoneId, zone: l.zone?.name ?? null, casier: l.casier, position: l.position };
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
export function placesOf(groups: Array<{ location: LocatedParts | null; quantity: number }>): Place[] {
  const total = groups.reduce((s, g) => s + g.quantity, 0);
  const located = groups
    .filter((g): g is { location: LocatedParts; quantity: number } => g.location != null && g.quantity > 0)
    .map((g) => ({ id: g.location.id, label: labelOf(g.location), quantity: g.quantity, zoneId: g.location.zoneId }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  const none = total - located.reduce((s, p) => s + p.quantity, 0);
  return none > 0 ? [...located, { id: null, label: NO_LOCATION, quantity: none, zoneId: null }] : located;
}

/** Colonne « Emplacements » de l'export : « Cave 2 / B / 3 × 4 ; Sans emplacement × 2 ». */
export function formatPlaces(places: Place[]): string {
  return places.map((p) => `${p.label} × ${p.quantity}`).join(' ; ');
}
