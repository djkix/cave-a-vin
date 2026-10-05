import { normalizeLabel } from '../appellations/appellations.service';

export interface CaveRow {
  id: string;
  producer: string;
  cuvee: string | null;
  appellationRaw: string;
  vintage: number | null;
  color: string;
  formatCl: number;
  referencePhotoId: string | null;
  quantity: number;
}

export interface CaveFilter {
  q?: string;
  color?: string;
  includeEmpty?: boolean;
  /** Fin d'apogée au plus tard l'an prochain ; appliqué après le calcul de l'apogée. */
  drinkSoon?: boolean;
  /** Vins sans estimation d'apogée ; appliqué après le calcul de l'apogée. */
  noApogee?: boolean;
  /** Plat à accompagner ; appliqué après le calcul de l'apogée. */
  dish?: string;
}

/** Tous les mots cherchés doivent apparaître, sans accents ni casse, dans producteur, cuvée ou appellation. */
export function filterCave<T extends CaveRow>(rows: T[], filter: CaveFilter): T[] {
  const words = normalizeLabel(filter.q ?? '').split(' ').filter(Boolean);
  return rows.filter((r) => {
    if (!filter.includeEmpty && r.quantity <= 0) return false;
    if (filter.color && r.color !== filter.color) return false;
    const haystack = normalizeLabel(`${r.producer} ${r.cuvee ?? ''} ${r.appellationRaw}`);
    return words.every((w) => haystack.includes(w));
  });
}
