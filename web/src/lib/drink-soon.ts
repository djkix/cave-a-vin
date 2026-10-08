import { useQuery } from '@tanstack/react-query';
import { CaveRow, getCave } from './api-client';
import { NO_LOCATION } from './locations';

/** Vins à boire prochainement : même critère que la case « À boire en priorité » de la cave. */
export function useDrinkSoon() {
  return useQuery({ queryKey: ['cave', { drinkSoon: true }], queryFn: () => getCave({ drinkSoon: true }) });
}

/** `zoneId` : zone de l'emplacement du groupe (indication et photo dans l'en-tête), null sans zone. */
export interface PlaceGroup { label: string; zoneId: string | null; wines: Array<{ wine: CaveRow; quantity: number }> }

/** Fin d'apogée la plus proche d'abord, puis la meilleure note. */
const urgency = (a: CaveRow, b: CaveRow) =>
  (a.apogee?.max ?? Infinity) - (b.apogee?.max ?? Infinity) || (b.rating?.value ?? -1) - (a.rating?.value ?? -1);

/**
 * Vins regroupés par emplacement, pour savoir où descendre : emplacements par
 * libellé, « Sans emplacement » en dernier. Un vin rangé à deux endroits figure
 * dans les deux groupes, avec la quantité de chacun.
 */
export function groupByPlace(wines: CaveRow[]): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  for (const wine of wines) {
    const places = wine.places?.length ? wine.places : [{ id: null, label: NO_LOCATION, quantity: wine.quantity }];
    for (const p of places) {
      const g = groups.get(p.label) ?? { label: p.label, zoneId: p.zoneId ?? null, wines: [] };
      g.wines.push({ wine, quantity: p.quantity });
      groups.set(p.label, g);
    }
  }
  for (const g of groups.values()) g.wines.sort((a, b) => urgency(a.wine, b.wine));
  return [...groups.values()].sort((a, b) =>
    a.label === NO_LOCATION ? 1 : b.label === NO_LOCATION ? -1 : a.label.localeCompare(b.label, 'fr'));
}

/** Où est rangé le vin, en une ligne : « Cave 1 / A, Garage ». */
export const whereLabel = (wine: CaveRow) => (wine.places?.length ? wine.places.map((p) => p.label).join(', ') : NO_LOCATION);
