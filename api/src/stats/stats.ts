import { Apogee } from '../apogee/apogee';

/**
 * Statistiques de la cave, calculées à la lecture. Fonction pure : le service
 * lui passe les vins (stock, région, apogée déjà estimée) et le journal.
 * Un mouvement annulé et tout ajustement (annulation, inventaire) ne sont ni
 * des entrées ni des sorties.
 */
export const STATS_TIME_ZONE = 'Europe/Paris';
export const STATS_MONTHS = 12;
export const RANKING_SIZE = 5;
export const NO_REGION = 'Sans région';
export const NO_VINTAGE = 'Non millésimé';
export const APOGEE_KEYS = ['TROP_JEUNE', 'A_BOIRE', 'A_BOIRE_VITE', 'PASSEE', 'SANS_ESTIMATION'] as const;

export interface StatsWine {
  id: string;
  producer: string;
  cuvee: string | null;
  vintage: number | null;
  color: string;
  region: string | null;
  quantity: number;
  apogee: Apogee;
  rating: number | null;
}

export interface StatsMovement {
  id: string;
  wineId: string;
  delta: number;
  type: 'IN' | 'OUT' | 'ADJUST';
  occurredAt: Date;
  priceUnitCents: number | null;
  reversesId: string | null;
}

export interface Share { key: string; bottles: number; share: number }
export interface MonthFlow { month: string; in: number; out: number }
export interface RankedWine { id: string; producer: string; cuvee: string | null; vintage: number | null; value: number }
export interface RankedProducer { producer: string; bottles: number }

export interface Stats {
  bottles: number;
  references: number;
  pricedReferences: number;
  purchaseValueCents: number | null;
  byColor: Share[];
  byRegion: Share[];
  byDecade: Share[];
  byApogee: Share[];
  months: MonthFlow[];
  drinkRate: number;
  yearsLeft: number | null;
  mostDrunk: RankedWine[];
  topProducers: RankedProducer[];
  mostExpensive: RankedWine[];
  bestRated: RankedWine[];
}

/** Champs tirés des prix d'achat : absents de la réponse pour un membre en lecture seule. */
export const PRICE_KEYS = ['pricedReferences', 'purchaseValueCents', 'mostExpensive'] as const;
export type ViewerStats = Omit<Stats, (typeof PRICE_KEYS)[number]>;

/** Statistiques vues par un rôle : un VIEWER ne reçoit aucun champ de prix (absents, pas null). */
export function statsForRole(stats: Stats, role: 'OWNER' | 'VIEWER'): Stats | ViewerStats {
  if (role === 'OWNER') return stats;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- champs de prix retirés de la réponse
  const { pricedReferences, purchaseValueCents, mostExpensive, ...rest } = stats;
  return rest;
}

const monthFormat = new Intl.DateTimeFormat('en-CA', { timeZone: STATS_TIME_ZONE, year: 'numeric', month: '2-digit' });

/** « AAAA-MM » du mois où tombe la date, à l'heure de Paris. */
export function monthKey(d: Date): string {
  const parts = monthFormat.formatToParts(d);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

/** Les `count` derniers mois, du plus ancien au mois en cours inclus. */
export function lastMonths(now: Date, count = STATS_MONTHS): string[] {
  const [y, m] = monthKey(now).split('-').map(Number);
  const current = y * 12 + (m - 1);
  return Array.from({ length: count }, (_, i) => {
    const idx = current - (count - 1 - i);
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
}

const byFr = (a: string, b: string) => a.localeCompare(b, 'fr');

function group<T>(items: T[], key: (t: T) => string, weight: (t: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of items) out.set(key(t), (out.get(key(t)) ?? 0) + weight(t));
  return out;
}

function shares(groups: Map<string, number>, total: number, order: (a: Share, b: Share) => number): Share[] {
  return [...groups].map(([key, bottles]) => ({ key, bottles, share: total ? bottles / total : 0 })).sort(order);
}

const biggestFirst = (a: Share, b: Share) => b.bottles - a.bottles || byFr(a.key, b.key);
const decadeOrder = (a: Share, b: Share) =>
  a.key === NO_VINTAGE ? 1 : b.key === NO_VINTAGE ? -1 : Number(a.key) - Number(b.key);

export function computeStats(input: { wines: StatsWine[]; movements: StatsMovement[] }, now: Date): Stats {
  const cancelled = new Set(input.movements.filter((m) => m.reversesId).map((m) => m.reversesId as string));
  const counted = input.movements.filter((m) => m.type !== 'ADJUST' && !cancelled.has(m.id));

  const lastPrice = new Map<string, number>();
  for (const m of [...counted].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    if (m.type === 'IN' && m.priceUnitCents != null) lastPrice.set(m.wineId, m.priceUnitCents);
  }

  const inStock = input.wines.filter((w) => w.quantity > 0);
  const qty = (w: StatsWine) => w.quantity;
  const bottles = inStock.reduce((s, w) => s + w.quantity, 0);
  const priced = inStock.filter((w) => lastPrice.has(w.id));

  const apogeeGroups = group(inStock, (w) => w.apogee.status ?? 'SANS_ESTIMATION', qty);

  const keys = lastMonths(now);
  const flows = new Map(keys.map((k) => [k, { month: k, in: 0, out: 0 }]));
  const drunk = new Map<string, number>();
  for (const m of counted) {
    const flow = flows.get(monthKey(m.occurredAt));
    if (!flow) continue;
    if (m.type === 'IN') flow.in += m.delta;
    else {
      flow.out += -m.delta;
      drunk.set(m.wineId, (drunk.get(m.wineId) ?? 0) - m.delta);
    }
  }
  const months = keys.map((k) => flows.get(k)!);
  const totalOut = months.reduce((s, f) => s + f.out, 0);

  const wineById = new Map(input.wines.map((w) => [w.id, w]));
  const ranked = (w: StatsWine, value: number): RankedWine => ({ id: w.id, producer: w.producer, cuvee: w.cuvee, vintage: w.vintage, value });
  const valueThenProducer = (a: RankedWine, b: RankedWine) => b.value - a.value || byFr(a.producer, b.producer);

  return {
    bottles,
    references: inStock.length,
    pricedReferences: priced.length,
    purchaseValueCents: priced.length ? priced.reduce((s, w) => s + w.quantity * lastPrice.get(w.id)!, 0) : null,
    byColor: shares(group(inStock, (w) => w.color, qty), bottles, biggestFirst),
    byRegion: shares(group(inStock, (w) => w.region ?? NO_REGION, qty), bottles, biggestFirst),
    byDecade: shares(
      group(inStock, (w) => (w.vintage == null ? NO_VINTAGE : String(Math.floor(w.vintage / 10) * 10)), qty),
      bottles,
      decadeOrder,
    ),
    byApogee: APOGEE_KEYS.map((key) => {
      const b = apogeeGroups.get(key) ?? 0;
      return { key, bottles: b, share: bottles ? b / bottles : 0 };
    }),
    months,
    drinkRate: Math.round((totalOut / STATS_MONTHS) * 10) / 10,
    // bouteilles ÷ (rythme mensuel × 12) = bouteilles ÷ sorties de l'année.
    yearsLeft: totalOut > 0 ? Math.round(bottles / totalOut) : null,
    mostDrunk: [...drunk]
      .filter(([id]) => wineById.has(id))
      .map(([id, count]) => ranked(wineById.get(id)!, count))
      .sort(valueThenProducer)
      .slice(0, RANKING_SIZE),
    topProducers: [...group(inStock, (w) => w.producer, qty)]
      .map(([producer, b]) => ({ producer, bottles: b }))
      .sort((a, b) => b.bottles - a.bottles || byFr(a.producer, b.producer))
      .slice(0, RANKING_SIZE),
    mostExpensive: priced.map((w) => ranked(w, lastPrice.get(w.id)!)).sort(valueThenProducer).slice(0, RANKING_SIZE),
    bestRated: input.wines
      .filter((w) => w.rating != null)
      .map((w) => ranked(w, w.rating as number))
      .sort(valueThenProducer)
      .slice(0, RANKING_SIZE),
  };
}
