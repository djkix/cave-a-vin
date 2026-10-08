import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getLocations, getZones, Location, LocationInput, Zone } from './api-client';

export const NO_LOCATION = 'Sans emplacement';
export const NO_ZONE = 'Sans zone';
export const EMPTY_LOCATION: LocationInput = { zoneId: null, casier: null, position: null };

/** Saisie → corps de l'api : casier et position nettoyés, null si vides ; rien de choisi ni saisi = null (« Sans emplacement »). */
export function toLocationInput(value: LocationInput): LocationInput | null {
  const clean = (v: string | null) => v?.trim() || null;
  const out = { zoneId: value.zoneId || null, casier: clean(value.casier), position: clean(value.position) };
  return out.zoneId || out.casier || out.position ? out : null;
}

/** Libellé d'une saisie, au format de l'api (« Cave 2 / B / 3 ») : la zone par son nom. */
export function inputLabel(value: LocationInput, zones: Zone[]): string {
  const zone = zones.find((z) => z.id === value.zoneId)?.name ?? null;
  return [zone, value.casier, value.position].map((v) => v?.trim()).filter(Boolean).join(' / ') || NO_LOCATION;
}

/** Casiers et positions déjà saisis dans la cave, sans doublon, pour les suggestions (`<datalist>`). */
export function distinctParts(locations: Location[]): Record<'casier' | 'position', string[]> {
  const pick = (k: 'casier' | 'position') =>
    [...new Set(locations.map((l) => l[k]).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'fr'));
  return { casier: pick('casier'), position: pick('position') };
}

/** Emplacement marqué `lastUsed` (dernière entrée rangée), ramené à sa saisie : zone (id), casier, position. */
export function lastUsedInput(locations: Location[] | undefined): LocationInput | null {
  const l = locations?.find((x) => x.lastUsed);
  return l ? { zoneId: l.zoneId ?? null, casier: l.casier, position: l.position } : null;
}

/** Zones de la cave dans l'ordre d'affichage (lisibles par un membre). Sans nouvelles tentatives : une erreur ne retient aucune saisie. */
export function useZones(enabled = true) {
  return useQuery({ queryKey: ['zones'], queryFn: getZones, enabled, retry: false });
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
 * (dernière entrée rangée, non annulée, de la cave), ramené à sa zone.
 * `loading` : tant que la liste n'est pas lue, l'entrée ne se confirme pas
 * (elle partirait sans lui) — mais 2 s au plus : passé ce délai, ou sur une
 * erreur, elle part sans pré-remplissage (« Sans emplacement »). Les zones de la
 * cave, pour le choix de la zone, ne retiennent jamais l'entrée.
 */
export function useLastLocation(): { locations: Location[]; zones: Zone[]; last: LocationInput | null; loading: boolean } {
  const query = useLocations();
  const zones = useZones();
  const last = useMemo(() => lastUsedInput(query.data), [query.data]);
  const loading = useBoundedWait(query.isLoading);
  return { locations: query.data ?? [], zones: zones.data ?? [], last, loading };
}
