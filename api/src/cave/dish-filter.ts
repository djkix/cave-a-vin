import { normalizeLabel } from '../appellations/appellations.service';

/** Premier plat suggéré qui contient tous les mots cherchés, sans accents ni casse ; null sinon. */
export function matchDish(dishes: string[] | null | undefined, query: string): string | null {
  const words = normalizeLabel(query).split(' ').filter(Boolean);
  if (!words.length || !dishes) return null;
  return dishes.find((d) => {
    const haystack = normalizeLabel(d);
    return words.every((w) => haystack.includes(w));
  }) ?? null;
}
