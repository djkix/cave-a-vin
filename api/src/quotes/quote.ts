import { z } from 'zod';

/**
 * Cote iDealwine saisie à la main par le propriétaire (jamais lue
 * automatiquement : les CGS d'iDealwine l'interdisent). Fonctions pures,
 * partagées par la fiche, les statistiques et l'export.
 */
export const COTE_INVALID = 'La cote doit être comprise entre 0,01 € et 100 000 €';
export const TRANSACTIONS_INVALID = 'Nombre de transactions invalide';
export const DATE_INVALID = 'Date de cote invalide';
export const URL_INVALID = 'Le lien doit être une page www.idealwine.com';

export const MAX_COTE_CENTS = 10_000_000;
export const MIN_QUOTED_ON = '1990-01-01';
/** La cote inclut les frais acheteur d'environ 16 % : valeur de cession estimée = cote / 1,16. */
export const BUYER_FEES_FACTOR = 1.16;
export const IDEALWINE_HOST = 'www.idealwine.com';
const QUOTE_TIME_ZONE = 'Europe/Paris';

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: QUOTE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** « AAAA-MM-JJ » du jour à Paris. */
export function parisToday(now = new Date()): string {
  return dayFormat.format(now);
}

/** Date réelle « AAAA-MM-JJ » (le 30 février est refusé), ni avant 1990 ni après aujourd'hui à Paris. */
function isValidQuotedOn(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  return s >= MIN_QUOTED_ON && s <= parisToday();
}

/** Lien https dont l'hôte est exactement www.idealwine.com (sans port ni identifiants). Analysé par URL, jamais par préfixe. */
export function isIdealwineUrl(s: string): boolean {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.host === IDEALWINE_HOST && url.username === '' && url.password === '';
}

const int32 = 2_147_483_647;

export const createQuoteSchema = z.object({
  coteCents: z
    .number({ required_error: COTE_INVALID, invalid_type_error: COTE_INVALID })
    .int(COTE_INVALID)
    .min(1, COTE_INVALID)
    .max(MAX_COTE_CENTS, COTE_INVALID),
  nTransactions: z
    .number({ invalid_type_error: TRANSACTIONS_INVALID })
    .int(TRANSACTIONS_INVALID)
    .min(0, TRANSACTIONS_INVALID)
    // Au-delà, la colonne INTEGER déborde et la base répondrait par une erreur 500.
    .max(int32, TRANSACTIONS_INVALID)
    .nullish(),
  quotedOn: z
    .string({ required_error: DATE_INVALID, invalid_type_error: DATE_INVALID })
    .refine(isValidQuotedOn, DATE_INVALID),
  /** Page iDealwine du vin ; vide = pas de lien. */
  sourceUrl: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v),
    z.string({ invalid_type_error: URL_INVALID }).max(2000, URL_INVALID).refine(isIdealwineUrl, URL_INVALID).nullish(),
  ),
});

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

/**
 * Recherche iDealwine sur « producteur cuvée » (forme de leur recherche :
 * `/fr/acheter-du-vin/recherche-mot_mot`), minuscules, sans accents. Sans le
 * millésime : la recherche montre tous les millésimes, on choisit le sien
 * (avec l'année, un millésime absent de leur catalogue ne donnerait rien).
 */
export function idealwineSearchUrl(wine: { producer: string; cuvee: string | null; vintage: number | null }): string {
  const slug = [wine.producer, wine.cuvee]
    .filter((p) => p != null && p !== '')
    .join(' ')
    // NFD ne décompose pas les ligatures : « Œuvre » donnerait « uvre ».
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `https://${IDEALWINE_HOST}/fr/acheter-du-vin/recherche-${slug}`;
}

interface Dated { quotedOn: Date; createdAt: Date }

const newestFirst = (a: Dated, b: Dated) => b.quotedOn.getTime() - a.quotedOn.getTime() || b.createdAt.getTime() - a.createdAt.getTime();

/** Cote courante : la dernière par date de cote, puis par date de saisie. */
export function currentQuote<T extends Dated>(quotes: T[]): T | null {
  return [...quotes].sort(newestFirst)[0] ?? null;
}

/** Lien iDealwine enregistré : celui de la cote courante, sinon de la plus récente cote qui en a un ; null si aucun. */
export function savedSourceUrl<T extends Dated & { sourceUrl: string | null }>(quotes: T[]): string | null {
  return [...quotes].sort(newestFirst).find((q) => q.sourceUrl)?.sourceUrl ?? null;
}

/** Cote courante de chaque vin. */
export function currentQuoteByWine<T extends Dated & { wineId: string }>(quotes: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const q of quotes) {
    const best = out.get(q.wineId);
    if (!best || newestFirst(q, best) < 0) out.set(q.wineId, q);
  }
  return out;
}

export function cessionCents(coteCents: number): number {
  return Math.round(coteCents / BUYER_FEES_FACTOR);
}

/** Lecture Prisma d'une cote, avec ce qu'il faut pour la vue. */
export const QUOTE_SELECT = {
  wineId: true, coteCents: true, nTransactions: true, quotedOn: true, sourceUrl: true, createdAt: true,
  enteredBy: { select: { displayName: true, email: true } },
} as const;

export interface QuoteView {
  coteCents: number;
  nTransactions: number | null;
  /** « AAAA-MM-JJ ». */
  quotedOn: string;
  sourceUrl: string | null;
  /** Nom affiché, sinon e-mail (vue réservée au propriétaire) ; null si le compte a été supprimé. */
  enteredBy: string | null;
  cessionCents: number;
}

export function quoteView(q: {
  coteCents: number; nTransactions: number | null; quotedOn: Date; sourceUrl: string | null;
  enteredBy: { displayName: string | null; email: string } | null;
}): QuoteView {
  return {
    coteCents: q.coteCents,
    nTransactions: q.nTransactions,
    quotedOn: q.quotedOn.toISOString().slice(0, 10),
    sourceUrl: q.sourceUrl,
    enteredBy: q.enteredBy ? q.enteredBy.displayName || q.enteredBy.email : null,
    cessionCents: cessionCents(q.coteCents),
  };
}
