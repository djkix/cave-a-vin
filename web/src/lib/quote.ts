/**
 * Cote iDealwine saisie à la main : jamais lue chez iDealwine (leurs CGS
 * l'interdisent). Lecture, âge et avertissements calculés ici, à partir de
 * `quotedOn` et `nTransactions`. Messages identiques à ceux de l'api.
 */
export const COTE_INVALID = 'La cote doit être comprise entre 0,01 € et 100 000 €';
export const TRANSACTIONS_INVALID = 'Nombre de transactions invalide';
export const DATE_INVALID = 'Date de cote invalide';
export const FEW_TRANSACTIONS = 'Peu de transactions : ordre de grandeur';
export const OLD_QUOTE = "Cote de plus d'un an";
const MAX_COTE_CENTS = 10_000_000;
const FEW_BELOW = 5;

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
/** « AAAA-MM-JJ » du jour à Paris, comme la borne de l'api. */
export const parisToday = (now = new Date()) => dayFormat.format(now);

/** Euros saisis (virgule ou point, deux décimales au plus) → centimes ; sinon le message. */
export function parseCoteEuros(text: string): number | string {
  const t = text.trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return COTE_INVALID;
  const cents = Math.round(Number(t) * 100);
  return cents >= 1 && cents <= MAX_COTE_CENTS ? cents : COTE_INVALID;
}

/** Vide → null ; entier ≥ 0 ; sinon le message. */
export function parseTransactions(text: string): number | null | string {
  const t = text.trim();
  if (t === '') return null;
  return /^\d{1,9}$/.test(t) ? Number(t) : TRANSACTIONS_INVALID;
}

const EUROS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const EUROS_CENTS = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** « 85 € », « 85,50 € » : les centimes seulement s'il y en a. */
export const formatCoteEuros = (cents: number) => `${(cents % 100 === 0 ? EUROS : EUROS_CENTS).format(cents / 100)} €`;
/** Estimation (valeur de cession, totaux) : à l'euro près. */
export const CESSION_NOTE = "(cote hors frais acheteur d'environ 16 %)";
export const formatEurosRounded = (cents: number) => `${EUROS.format(Math.round(cents / 100))} €`;

const parts = (day: string) => day.split('-').map(Number) as [number, number, number];

/** « il y a 7 mois » entre la date de cote et `today` (deux « AAAA-MM-JJ »). */
export function quoteAge(quotedOn: string, today = parisToday()): string {
  const [y1, m1, d1] = parts(quotedOn);
  const [y2, m2, d2] = parts(today);
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  if (months >= 12) {
    const years = Math.floor(months / 12);
    return `il y a ${years} an${years > 1 ? 's' : ''}`;
  }
  if (months >= 1) return `il y a ${months} mois`;
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
  if (days <= 0) return 'aujourd’hui';
  return `il y a ${days} jour${days > 1 ? 's' : ''}`;
}

const LONG_DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** « 85 € — 12 transactions — cote du 3 mars 2026, il y a 7 mois » ; sans nombre connu, le segment disparaît. */
export function quoteLine(q: { coteCents: number; nTransactions: number | null; quotedOn: string }, today = parisToday()): string {
  const n = q.nTransactions;
  return [
    formatCoteEuros(q.coteCents),
    n == null ? null : `${n} transaction${n > 1 ? 's' : ''}`,
    `cote du ${LONG_DATE.format(new Date(`${q.quotedOn}T00:00:00Z`))}, ${quoteAge(q.quotedOn, today)}`,
  ].filter(Boolean).join(' — ');
}

/** Sous 5 transactions (nombre connu) ; au-delà de 12 mois (la date anniversaire passée). */
export function quoteWarnings(q: { nTransactions: number | null; quotedOn: string }, today = parisToday()): string[] {
  const out: string[] = [];
  if (q.nTransactions != null && q.nTransactions < FEW_BELOW) out.push(FEW_TRANSACTIONS);
  const [y, m, d] = parts(q.quotedOn);
  const anniversary = `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (anniversary < today) out.push(OLD_QUOTE);
  return out;
}
