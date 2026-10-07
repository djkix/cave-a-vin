import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
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

/** Emplacements de la cave (lisibles par un membre). Sans nouvelles tentatives : une erreur ne retient pas l'entrée. */
export function useLocations(enabled = true) {
  return useQuery({ queryKey: ['locations'], queryFn: getLocations, enabled, retry: false });
}

/** Au plus 2 s d'attente d'une lecture avant d'agir sans elle (entrée sans pré-remplissage, sortie sans endroit). */
export const MAX_WAIT_MS = 2000;

/** Vrai tant que `waiting` et que MAX_WAIT_MS ne se sont pas écoulées depuis l'affichage, quel que soit l'état de la lecture. */
export function useBoundedWait(waiting: boolean, ms = MAX_WAIT_MS): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return waiting && !expired;
}

/**
 * Pré-remplissage de l'entrée : l'emplacement que le serveur marque `lastUsed`
 * (dernière entrée rangée, non annulée, de la cave). `loading` : tant que la
 * liste n'est pas lue, l'entrée ne se confirme pas (elle partirait sans lui) —
 * mais 2 s au plus : passé ce délai, ou sur une erreur, elle part sans
 * pré-remplissage (« Sans emplacement »).
 */
export function useLastLocation(): { locations: Location[]; last: LocationParts | null; loading: boolean } {
  const query = useLocations();
  const last = useMemo(() => {
    const l = query.data?.find((x) => x.lastUsed);
    return l ? { zone: l.zone, casier: l.casier, position: l.position } : null;
  }, [query.data]);
  const loading = useBoundedWait(query.isLoading);
  return { locations: query.data ?? [], last, loading };
}
