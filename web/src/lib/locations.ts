import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getLocations, Location, LocationParts } from './api-client';

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

/**
 * Pré-remplissage de l'entrée : l'emplacement que le serveur marque `lastUsed`
 * (dernière entrée rangée, non annulée, de la cave). `loading` : tant que la
 * liste n'est pas lue, l'entrée ne se confirme pas (elle partirait sans lui).
 */
export function useLastLocation(): { locations: Location[]; last: LocationParts | null; loading: boolean } {
  const query = useLocations();
  const last = useMemo(() => {
    const l = query.data?.find((x) => x.lastUsed);
    return l ? { zone: l.zone, casier: l.casier, position: l.position } : null;
  }, [query.data]);
  return { locations: query.data ?? [], last, loading: query.isLoading };
}
