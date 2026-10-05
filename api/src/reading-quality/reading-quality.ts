import { parseExtraction } from '../vision/extraction-schema';

/**
 * Mesure « zéro saisie » : part des champs que l'utilisateur a dû corriger à
 * la main à l'entrée par photo. Un champ est corrigé quand la valeur confirmée
 * diffère de celle que l'écran de confirmation avait pré-remplie à partir de
 * la lecture — mêmes valeurs par défaut que `web/src/lib/extraction-to-draft.ts`.
 */
export const READ_FIELDS = ['producer', 'cuvee', 'appellationRaw', 'vintage', 'color', 'formatCl'] as const;
export type ReadField = (typeof READ_FIELDS)[number];

type Draft = Record<ReadField, string | number | null>;

/** Ce que l'écran a proposé ; une lecture absente ou illisible donne un formulaire vide. */
function prefill(rawExtraction: unknown): Draft {
  let e: ReturnType<typeof parseExtraction> | null = null;
  try {
    e = rawExtraction == null ? null : parseExtraction(rawExtraction);
  } catch {
    e = null;
  }
  return {
    producer: e?.producer.value ?? '',
    cuvee: e?.cuvee.value ?? '',
    appellationRaw: e?.appellation.value ?? '',
    vintage: e?.vintage.value ?? null,
    color: e?.color.value ?? 'ROUGE',
    formatCl: e?.formatCl.value ?? 75,
  };
}

/** Espaces autour ignorés, champ texte vide et absent confondus ; majuscules et accents comptent. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : v ?? '');
  return norm(a) === norm(b);
}

export function correctedFields(rawExtraction: unknown, confirmed: Record<string, unknown>): ReadField[] {
  const proposed = prefill(rawExtraction);
  return READ_FIELDS.filter((f) => !same(proposed[f], confirmed[f]));
}

export interface ReadingQuality {
  entries: number;
  rate: number | null;
  fields: Array<{ field: ReadField; corrected: number; rate: number | null }>;
}

export function summarize(perEntry: ReadField[][]): ReadingQuality {
  const entries = perEntry.length;
  const total = perEntry.reduce((n, c) => n + c.length, 0);
  return {
    entries,
    rate: entries ? total / (entries * READ_FIELDS.length) : null,
    fields: READ_FIELDS.map((field) => {
      const corrected = perEntry.filter((c) => c.includes(field)).length;
      return { field, corrected, rate: entries ? corrected / entries : null };
    }),
  };
}
