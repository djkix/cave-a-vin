import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getLocations, getRecentMovements, Location, LocationParts, MovementWithWine } from './api-client';

export const NO_LOCATION = 'Sans emplacement';
export const EMPTY_LOCATION: LocationParts = { zone: null, casier: null, position: null };

/** Champs saisis → corps de l'api : chaque champ nettoyé, null si vide ; tout vide = null (« Sans emplacement »). */
export function toLocationInput(parts: LocationParts): LocationParts | null {
  const clean = (v: string | null) => v?.trim() || null;
  const out = { zone: clean(parts.zone), casier: clean(parts.casier), position: clean(parts.position) };
  return out.zone || out.casier || out.position ? out : null;
}

/** Libellé affiché, au format de l'api (« Cave 2 / B / 3 »). */
export function labelOf(parts: LocationParts): string {
  return [parts.zone, parts.casier, parts.position].map((v) => v?.trim()).filter(Boolean).join(' / ') || NO_LOCATION;
}

/**
 * Emplacement de la dernière entrée rangée et non annulée de la cave, lu dans
 * le journal (le plus récent d'abord) : l'api ne l'expose que sur la fiche
 * d'un vin, inconnue à l'entrée.
 */
export function lastInLocation(rows: MovementWithWine[] | undefined, locations: Location[] | undefined): LocationParts | null {
  if (!rows || !locations) return null;
  const reversed = new Set(rows.map((r) => r.reversesId).filter(Boolean));
  const last = rows.find((r) => r.type === 'IN' && r.locationId && !reversed.has(r.id));
  const loc = last && locations.find((l) => l.id === last.locationId);
  return loc ? { zone: loc.zone, casier: loc.casier, position: loc.position } : null;
}

/** Valeurs distinctes de chaque champ, pour les suggestions (`<datalist>`). */
export function distinctParts(locations: Location[]): Record<keyof LocationParts, string[]> {
  const pick = (k: keyof LocationParts) =>
    [...new Set(locations.map((l) => l[k]).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'fr'));
  return { zone: pick('zone'), casier: pick('casier'), position: pick('position') };
}

/** Emplacements de la cave (lisibles par un membre). */
export function useLocations(enabled = true) {
  return useQuery({ queryKey: ['locations'], queryFn: getLocations, enabled });
}

/** Le journal ne garde que les 100 derniers mouvements : une entrée rangée plus ancienne ne pré-remplit plus. */
const RECENT_FOR_PREFILL = 100;

/** Pré-remplissage de l'entrée (écrans réservés au propriétaire : le journal l'est aussi). */
export function useLastLocation(): { locations: Location[]; last: LocationParts | null } {
  const locations = useLocations();
  const recent = useQuery({ queryKey: ['movements', 'recent', RECENT_FOR_PREFILL], queryFn: () => getRecentMovements(RECENT_FOR_PREFILL) });
  const last = useMemo(() => lastInLocation(recent.data, locations.data), [recent.data, locations.data]);
  return { locations: locations.data ?? [], last };
}
