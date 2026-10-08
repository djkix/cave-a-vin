import { STATS_TIME_ZONE } from '../stats/stats';
import { GEMINI_USAGES } from '../vision/gemini-journal';

export const GEMINI_USAGE_DEFAULT_DAYS = 7;
export const GEMINI_USAGE_MAX_DAYS = 90;

export interface GeminiCallRow {
  createdAt: Date;
  usage: string;
  outcome: string;
  httpStatus: number | null;
  costCents: number;
}

export interface GeminiUsageRow {
  /** Jour à Paris, AAAA-MM-JJ. */
  day: string;
  usage: string;
  ok: number;
  refused503: number;
  refused429: number;
  errors: number;
  costCents: number;
}

export interface GeminiUsageTotals {
  ok: number;
  refused: number;
  errors: number;
  costCents: number;
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: STATS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Jour calendaire à Paris (comme les statistiques de la cave), AAAA-MM-JJ. */
export function parisDay(date: Date): string {
  return dayFormat.format(date);
}

/** Jour `n` jours avant `day` (AAAA-MM-JJ), calculé sur le calendrier : sans effet des changements d'heure. */
function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Début (large) de la période à lire en base : un jour de plus couvre tout décalage de fuseau. */
export function usageSince(now: Date, days: number): Date {
  return new Date(now.getTime() - (days + 1) * 24 * 3600 * 1000);
}

const usageRank = (usage: string) => {
  const i = (GEMINI_USAGES as readonly string[]).indexOf(usage);
  return i === -1 ? GEMINI_USAGES.length : i;
};

/**
 * Consommation par jour de Paris (les `days` derniers, aujourd'hui compris) et
 * par usage, du jour le plus récent au plus ancien, puis dans l'ordre des usages
 * (lecture à l'entrée, à la sortie, accords, descriptifs, recherche d'image).
 */
export function aggregateGeminiUsage(calls: GeminiCallRow[], now: Date, days: number): { rows: GeminiUsageRow[]; totals: GeminiUsageTotals } {
  const today = parisDay(now);
  const first = daysBefore(today, days - 1);
  const byKey = new Map<string, GeminiUsageRow>();
  const totals: GeminiUsageTotals = { ok: 0, refused: 0, errors: 0, costCents: 0 };
  for (const c of calls) {
    const day = parisDay(c.createdAt);
    if (day < first || day > today) continue;
    const key = `${day}|${c.usage}`;
    let row = byKey.get(key);
    if (!row) {
      row = { day, usage: c.usage, ok: 0, refused503: 0, refused429: 0, errors: 0, costCents: 0 };
      byKey.set(key, row);
    }
    if (c.outcome === 'OK') {
      row.ok++;
      totals.ok++;
    } else if (c.outcome === 'REFUSE') {
      if (c.httpStatus === 429) row.refused429++;
      else row.refused503++;
      totals.refused++;
    } else {
      row.errors++;
      totals.errors++;
    }
    row.costCents += c.costCents;
    totals.costCents += c.costCents;
  }
  const rows = [...byKey.values()].sort((a, b) => (a.day === b.day ? usageRank(a.usage) - usageRank(b.usage) : a.day < b.day ? 1 : -1));
  return { rows, totals };
}
