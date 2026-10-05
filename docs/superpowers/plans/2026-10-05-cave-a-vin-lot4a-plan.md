# Lot 4a — Statistiques : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une page « Statistiques » (5e onglet) qui montre la valeur de la cave au prix d'achat, la répartition du stock, les mouvements sur 12 mois et des classements, calculés à la lecture par `GET /api/stats`.

**Architecture:** Une fonction pure `computeStats` (api/src/stats/stats.ts) reçoit les vins (avec stock, région et apogée déjà estimée) et le journal des mouvements, et rend tout le calcul ; un `StatsService` lit les données en réutilisant `CaveService.allWithStock()` et l'estimation d'apogée existante. Côté web, une page `/stats` affiche des barres en HTML/CSS ; l'onglet Cave apprend à cocher un filtre d'apogée depuis l'URL.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL 16, Jest (api) ; React 18, TanStack Query 5, React Router, Vitest + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-10-05-cave-a-vin-lot4a-statistiques-design.md`

## Global Constraints

- Tout texte visible par l'utilisateur et tout message d'erreur est **en français**.
- Aucune migration, aucune nouvelle variable d'environnement, `docker-compose.yml` inchangé.
- Aucune nouvelle dépendance npm (graphiques en HTML/CSS).
- Mois comptés dans le fuseau `Europe/Paris` ; fenêtre fixe de **12 mois**, mois en cours inclus.
- Prix d'achat retenu : **dernier prix d'achat saisi** d'un mouvement `IN` non annulé.
- Mouvement annulé (référencé par un `reverses_id`) et tout `ADJUST` (annulation ou inventaire) : ni entrée ni sortie.
- Montants affichés arrondis à l'euro, précédés de « ~ » ; pourcentages entiers ; chiffres en classe `num`.
- Messages de commit en français, conventionnels (`feat:` pour livrer la 1.6.0). Attribution : exactement une ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Base de test : uniquement `cave_test` (`DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test`, `REDIS_URL=redis://localhost:6379`) ; jamais la base `cave`.

## Review Focus

1. Un mouvement saisi le dernier jour du mois tard le soir (heure de Paris) doit compter dans ce mois-là, pas le suivant — test `monthKey` en Task 1.
2. Un vin épuisé mais bu dans l'année doit apparaître dans « Les plus bus » — test en Task 1.
3. Un prix d'achat porté par une entrée annulée ne doit pas devenir le « dernier prix » — test en Task 1.
4. Une cave avec du stock mais aucune sortie sur 12 mois : « Aucune bouteille sortie sur 12 mois », pas de durée de cave — test en Task 4.
5. Plus de 8 régions : les 8 premières puis une ligne « Autres » qui totalise le reste — test en Task 4.

---

### Task 1: Calcul pur des statistiques

**Files:**
- Create: `api/src/stats/stats.ts`
- Test: `api/src/stats/stats.spec.ts`

**Interfaces:**
- Consumes: `Apogee` de `api/src/apogee/apogee.ts`.
- Produces (utilisés par la Task 2) :
  - `export interface StatsWine { id: string; producer: string; cuvee: string | null; vintage: number | null; color: string; region: string | null; quantity: number; apogee: Apogee }`
  - `export interface StatsMovement { id: string; wineId: string; delta: number; type: 'IN' | 'OUT' | 'ADJUST'; occurredAt: Date; priceUnitCents: number | null; reversesId: string | null }`
  - `export interface Stats` (forme de la réponse API, ci-dessous)
  - `export function computeStats(input: { wines: StatsWine[]; movements: StatsMovement[] }, now: Date): Stats`
  - `export function monthKey(d: Date): string` (« AAAA-MM », heure de Paris) et `export function lastMonths(now: Date, count?: number): string[]`

- [ ] **Step 1: Write the failing test**

Créer `api/src/stats/stats.spec.ts` :

```ts
import { Apogee, ApogeeStatus } from '../apogee/apogee';
import { computeStats, lastMonths, monthKey, StatsMovement, StatsWine } from './stats';

const NOW = new Date('2026-10-15T12:00:00Z');
const ap = (status: ApogeeStatus | null): Apogee => ({ min: null, max: null, confidence: null, status, reason: null, source: null });
const wine = (id: string, over: Partial<StatsWine> = {}): StatsWine => ({
  id, producer: `P-${id}`, cuvee: null, vintage: 2019, color: 'ROUGE', region: 'Provence', quantity: 1, apogee: ap('A_BOIRE'), ...over,
});
let n = 0;
const mv = (wineId: string, type: StatsMovement['type'], delta: number, at: string, over: Partial<StatsMovement> = {}): StatsMovement => ({
  id: `m${++n}`, wineId, type, delta, occurredAt: new Date(at), priceUnitCents: null, reversesId: null, ...over,
});

describe('monthKey et lastMonths (heure de Paris)', () => {
  it('range un mouvement du 30 septembre à 23 h 30 à Paris en septembre, et celui de 00 h 30 le 1er octobre en octobre', () => {
    expect(monthKey(new Date('2026-09-30T21:30:00Z'))).toBe('2026-09');
    expect(monthKey(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10');
  });

  it('donne les 12 derniers mois, mois en cours inclus', () => {
    const keys = lastMonths(NOW);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2025-11');
    expect(keys[11]).toBe('2026-10');
  });

  it('franchit le changement d’année', () => {
    expect(lastMonths(new Date('2026-01-10T12:00:00Z'), 3)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('computeStats — valeur et volume', () => {
  it('valorise au dernier prix d’achat et compte à part les vins sans prix', () => {
    const wines = [wine('w1', { quantity: 6 }), wine('w2', { quantity: 2 }), wine('w3', { quantity: 0 })];
    const movements = [
      mv('w1', 'IN', 6, '2026-01-10T10:00:00Z', { priceUnitCents: 4000 }),
      mv('w1', 'IN', 6, '2026-02-10T10:00:00Z', { priceUnitCents: 4800 }),
    ];
    const s = computeStats({ wines, movements }, NOW);
    expect(s).toMatchObject({ bottles: 8, references: 2, pricedReferences: 1, purchaseValueCents: 6 * 4800 });
  });

  it('ignore le prix d’une entrée annulée', () => {
    const cancelledIn = mv('w1', 'IN', 1, '2026-03-10T10:00:00Z', { priceUnitCents: 9000 });
    const movements = [
      mv('w1', 'IN', 6, '2026-01-10T10:00:00Z', { priceUnitCents: 4000 }),
      cancelledIn,
      mv('w1', 'ADJUST', -1, '2026-03-10T11:00:00Z', { reversesId: cancelledIn.id }),
    ];
    const s = computeStats({ wines: [wine('w1', { quantity: 6 })], movements }, NOW);
    expect(s.purchaseValueCents).toBe(6 * 4000);
  });

  it('n’annonce aucune valeur quand aucun prix n’est connu', () => {
    const s = computeStats({ wines: [wine('w1', { quantity: 3 })], movements: [] }, NOW);
    expect(s.purchaseValueCents).toBeNull();
    expect(s.pricedReferences).toBe(0);
  });
});

describe('computeStats — répartition', () => {
  const wines = [
    wine('a', { quantity: 6, color: 'ROUGE', region: 'Rhône', vintage: 2016, apogee: ap('A_BOIRE') }),
    wine('b', { quantity: 3, color: 'BLANC', region: null, vintage: 2021, apogee: ap('TROP_JEUNE') }),
    wine('c', { quantity: 1, color: 'PETILLANT', region: 'Champagne', vintage: null, apogee: ap(null) }),
    wine('d', { quantity: 0, color: 'ROSE', region: 'Provence', vintage: 2023 }),
  ];
  const s = computeStats({ wines, movements: [] }, NOW);

  it('par couleur, du plus grand au plus petit, sans les vins épuisés', () => {
    expect(s.byColor).toEqual([
      { key: 'ROUGE', bottles: 6, share: 0.6 }, { key: 'BLANC', bottles: 3, share: 0.3 }, { key: 'PETILLANT', bottles: 1, share: 0.1 },
    ]);
  });

  it('par région, « Sans région » pour une appellation non reconnue', () => {
    expect(s.byRegion.map((r) => r.key)).toEqual(['Rhône', 'Sans région', 'Champagne']);
  });

  it('par décennie croissante, « Non millésimé » en dernier', () => {
    expect(s.byDecade.map((r) => [r.key, r.bottles])).toEqual([['2010', 6], ['2020', 3], ['Non millésimé', 1]]);
  });

  it('par statut d’apogée, dans l’ordre fixe, y compris les statuts vides', () => {
    expect(s.byApogee.map((r) => [r.key, r.bottles])).toEqual([
      ['TROP_JEUNE', 3], ['A_BOIRE', 6], ['A_BOIRE_VITE', 0], ['PASSEE', 0], ['SANS_ESTIMATION', 1],
    ]);
  });
});

describe('computeStats — mouvements sur 12 mois', () => {
  it('compte entrées et sorties par mois, sans annulations, inventaires ni mouvements hors fenêtre', () => {
    const cancelledOut = mv('w1', 'OUT', -2, '2026-10-02T10:00:00Z');
    const movements = [
      mv('w1', 'IN', 6, '2026-03-05T10:00:00Z'),
      mv('w1', 'OUT', -1, '2026-10-01T10:00:00Z'),
      cancelledOut,
      mv('w1', 'ADJUST', 2, '2026-10-02T11:00:00Z', { reversesId: cancelledOut.id }),
      mv('w1', 'ADJUST', -3, '2026-10-03T10:00:00Z'),
      mv('w1', 'OUT', -4, '2025-10-20T10:00:00Z'),
    ];
    const s = computeStats({ wines: [wine('w1', { quantity: 5 })], movements }, NOW);
    expect(s.months).toHaveLength(12);
    expect(s.months.find((m) => m.month === '2026-03')).toEqual({ month: '2026-03', in: 6, out: 0 });
    expect(s.months.find((m) => m.month === '2026-10')).toEqual({ month: '2026-10', in: 0, out: 1 });
    expect(s.months.find((m) => m.month === '2026-01')).toEqual({ month: '2026-01', in: 0, out: 0 });
    expect(s.drinkRate).toBe(0.1);
    expect(s.yearsLeft).toBe(5);
  });

  it('sans sortie, ni rythme ni durée', () => {
    const s = computeStats({ wines: [wine('w1', { quantity: 5 })], movements: [mv('w1', 'IN', 5, '2026-05-01T10:00:00Z')] }, NOW);
    expect(s.drinkRate).toBe(0);
    expect(s.yearsLeft).toBeNull();
  });
});

describe('computeStats — classements', () => {
  it('les plus bus sur 12 mois, y compris un vin épuisé, départagés par producteur, limités à 5', () => {
    const wines = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => wine(id, { producer: `Domaine ${id.toUpperCase()}`, quantity: id === 'a' ? 0 : 1 }));
    const movements = [
      mv('a', 'OUT', -3, '2026-09-01T10:00:00Z'),
      ...['c', 'b', 'd', 'e', 'f'].map((id) => mv(id, 'OUT', -1, '2026-09-02T10:00:00Z')),
    ];
    const s = computeStats({ wines, movements }, NOW);
    expect(s.mostDrunk.map((w) => [w.id, w.value])).toEqual([['a', 3], ['b', 1], ['c', 1], ['d', 1], ['e', 1]]);
  });

  it('les producteurs les plus présents en stock', () => {
    const wines = [wine('a', { producer: 'Tempier', quantity: 6 }), wine('b', { producer: 'Tempier', quantity: 2 }), wine('c', { producer: 'Ott', quantity: 3 })];
    expect(computeStats({ wines, movements: [] }, NOW).topProducers).toEqual([{ producer: 'Tempier', bottles: 8 }, { producer: 'Ott', bottles: 3 }]);
  });

  it('les bouteilles en stock les plus chères au dernier prix d’achat', () => {
    const wines = [wine('a', { quantity: 1 }), wine('b', { quantity: 1 }), wine('c', { quantity: 0 })];
    const movements = [
      mv('a', 'IN', 1, '2026-01-01T10:00:00Z', { priceUnitCents: 2000 }),
      mv('b', 'IN', 1, '2026-01-01T10:00:00Z', { priceUnitCents: 9000 }),
      mv('c', 'IN', 1, '2026-01-01T10:00:00Z', { priceUnitCents: 50000 }),
    ];
    expect(computeStats({ wines, movements }, NOW).mostExpensive.map((w) => [w.id, w.value])).toEqual([['b', 9000], ['a', 2000]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/stats/stats.spec.ts`
Expected: FAIL — `Cannot find module './stats'`.

- [ ] **Step 3: Write the implementation**

Créer `api/src/stats/stats.ts` :

```ts
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
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/stats/stats.spec.ts && npx tsc --noEmit && npx eslint src/stats --quiet`
Expected: PASS, aucune erreur de type ni de lint.

- [ ] **Step 5: Commit**

```bash
git add api/src/stats/stats.ts api/src/stats/stats.spec.ts
git commit -m "feat(stats): calcul des statistiques de la cave

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Route `GET /api/stats`

**Files:**
- Modify: `api/src/cave/cave.service.ts` (exporter `CaveDbRow` et une fonction `apogeeOf`, que `toItem` réutilise)
- Modify: `api/src/cave/cave.module.ts` (exporter `CaveService`)
- Create: `api/src/stats/stats.service.ts`, `api/src/stats/stats.controller.ts`, `api/src/stats/stats.module.ts`
- Modify: `api/src/app.module.ts` (importer `StatsModule`, import trié alphabétiquement entre `QueueModule` et `WinesModule`)
- Test: `api/src/stats/stats.service.spec.ts`, `api/src/app.e2e.spec.ts`

**Interfaces:**
- Consumes: `computeStats`, `StatsWine`, `StatsMovement`, `Stats` (Task 1) ; `CaveService.allWithStock()` ; `ApogeeRulesService.load()` ; `estimateApogee`.
- Produces: `GET /api/stats` (session) → `Stats` en JSON ; `export function apogeeOf(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): Apogee` dans `cave.service.ts`.

- [ ] **Step 1: Write the failing tests**

Créer `api/src/stats/stats.service.spec.ts` :

```ts
import { compileApogeeRules } from '../apogee/apogee';
import { StatsService } from './stats.service';

describe('StatsService', () => {
  it('passe au calcul les vins avec région et apogée estimée, et tout le journal', async () => {
    const row = {
      id: 'w1', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
      color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
      appellationId: 'a-cdp', region: 'Rhône', referenceGuardMin: 8, referenceGuardMax: 20, apogeeMin: null, apogeeMax: null, apogeeSource: null,
    };
    const findMany = jest.fn(async () => [
      { id: 'm1', wineId: 'w1', delta: 2, type: 'IN', occurredAt: new Date('2026-09-01T10:00:00Z'), priceUnitCents: 3000, reversesId: null },
    ]);
    const s = new StatsService(
      { movement: { findMany } } as any,
      { allWithStock: async () => [row] } as any,
      { load: async () => compileApogeeRules({ guardOverrides: [], vintageQualities: [] }) } as any,
    );
    const stats = await s.compute(new Date('2026-10-15T12:00:00Z'));
    expect(stats).toMatchObject({ bottles: 2, purchaseValueCents: 6000 });
    expect(stats.byRegion).toEqual([{ key: 'Rhône', bottles: 2, share: 1 }]);
    expect(stats.byApogee.find((a) => a.key === 'A_BOIRE')?.bottles).toBe(2);
    expect(findMany).toHaveBeenCalledWith({
      select: { id: true, wineId: true, delta: true, type: true, occurredAt: true, priceUnitCents: true, reversesId: true },
    });
  });
});
```

Dans `api/src/app.e2e.spec.ts`, ajouter ce cas juste avant `it('refuses the admin listing without a session'` (la session de l'agent est ouverte par un cas précédent) :

```ts
  it('serves the cave statistics to a signed-in account, never without a session', async () => {
    const res = await agent.get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      bottles: expect.any(Number), references: expect.any(Number), pricedReferences: expect.any(Number),
      byColor: expect.any(Array), byRegion: expect.any(Array), byDecade: expect.any(Array), byApogee: expect.any(Array),
      drinkRate: expect.any(Number), mostDrunk: expect.any(Array), topProducers: expect.any(Array), mostExpensive: expect.any(Array),
    }));
    expect(res.body.months).toHaveLength(12);
    expect((await supertest(app.getHttpServer()).get('/api/stats')).status).toBe(401);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/stats/stats.service.spec.ts`
Expected: FAIL — `Cannot find module './stats.service'`.

- [ ] **Step 3: Write the implementation**

Dans `api/src/cave/cave.service.ts`, remplacer le type `CaveDbRow` et la fonction `toItem` par :

```ts
/** Ligne lue en base : la ligne publique plus ce qu'il faut pour estimer l'apogée. */
export type CaveDbRow = CaveRow & Omit<ApogeeWineInput, 'vintage' | 'color'>;

export type CaveItem = CaveRow & { apogee: Apogee };

/** Apogée d'une ligne lue en base : partagé par la liste, la fiche et les statistiques. */
export function apogeeOf(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): Apogee {
  return estimateApogee(
    {
      vintage: row.vintage, color: row.color, appellationId: row.appellationId ?? null, region: row.region ?? null,
      referenceGuardMin: row.referenceGuardMin ?? null, referenceGuardMax: row.referenceGuardMax ?? null,
      apogeeMin: row.apogeeMin ?? null, apogeeMax: row.apogeeMax ?? null, apogeeSource: row.apogeeSource ?? null,
    },
    rules, currentYear,
  );
}

function toItem(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): CaveItem {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- champs internes retirés de la réponse
  const { appellationId, region, referenceGuardMin, referenceGuardMax, apogeeMin, apogeeMax, apogeeSource, ...pub } = row;
  return { ...pub, apogee: apogeeOf(row, rules, currentYear) };
}
```

(Si le lint du dépôt n'exige pas le commentaire `eslint-disable` sur cette déstructuration — vérifier avec `npx eslint src/cave --quiet` — le retirer.)

Dans `api/src/cave/cave.module.ts`, ajouter `exports: [CaveService]` :

```ts
@Module({ imports: [AuthModule, MovementsModule, ApogeeModule], controllers: [CaveController], providers: [CaveService], exports: [CaveService] })
export class CaveModule {}
```

Créer `api/src/stats/stats.service.ts` :

```ts
import { Injectable } from '@nestjs/common';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { apogeeOf, CaveService } from '../cave/cave.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeStats, Stats, StatsMovement } from './stats';

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cave: CaveService,
    private readonly rules: ApogeeRulesService,
  ) {}

  /** Tout le journal est lu : quelques milliers de lignes, sommées en mémoire. */
  async compute(now = new Date()): Promise<Stats> {
    const [rows, rules, movements] = await Promise.all([
      this.cave.allWithStock(),
      this.rules.load(),
      this.prisma.movement.findMany({
        select: { id: true, wineId: true, delta: true, type: true, occurredAt: true, priceUnitCents: true, reversesId: true },
      }),
    ]);
    const year = now.getFullYear();
    const wines = rows.map((r) => ({
      id: r.id, producer: r.producer, cuvee: r.cuvee, vintage: r.vintage, color: r.color,
      region: r.region ?? null, quantity: r.quantity, apogee: apogeeOf(r, rules, year),
    }));
    return computeStats({ wines, movements: movements as StatsMovement[] }, now);
  }
}
```

Créer `api/src/stats/stats.controller.ts` :

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { StatsService } from './stats.service';

@Controller('stats')
@UseGuards(AuthenticatedGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  get() {
    return this.stats.compute();
  }
}
```

Créer `api/src/stats/stats.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { ApogeeModule } from '../apogee/apogee.module';
import { AuthModule } from '../auth/auth.module';
import { CaveModule } from '../cave/cave.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({ imports: [AuthModule, CaveModule, ApogeeModule], controllers: [StatsController], providers: [StatsService] })
export class StatsModule {}
```

Dans `api/src/app.module.ts`, ajouter `import { StatsModule } from './stats/stats.module';` (entre `QueueModule`/`ReadingQualityModule` et `WinesModule`) et `StatsModule,` dans `imports`.

- [ ] **Step 4: Run tests to verify they pass**

Run (Postgres et Redis locaux démarrés : `LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@16 start`, `redis-server --daemonize yes`) :
`cd api && npx tsc --noEmit && npx eslint src --quiet && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest`
Expected: toute la suite passe, y compris `src/cave` (liste et fiche inchangées) et le cas e2e.

- [ ] **Step 5: Commit**

```bash
git add api/src/cave/cave.service.ts api/src/cave/cave.module.ts api/src/stats api/src/app.module.ts api/src/app.e2e.spec.ts
git commit -m "feat(stats): route GET /api/stats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Client web et filtre d'apogée de l'onglet Cave depuis l'URL

**Files:**
- Modify: `web/src/lib/api-client.ts` (types `Stats` et `getStats`)
- Modify: `web/src/pages/CavePage.tsx:16-22` (filtre d'apogée initial lu dans `?filtre=`)
- Test: `web/src/pages/CavePage.test.tsx`

**Interfaces:**
- Produces (pour la Task 4) :
  - `export interface StatsShare { key: string; bottles: number; share: number }`
  - `export interface StatsRankedWine { id: string; producer: string; cuvee: string | null; vintage: number | null; value: number }`
  - `export interface Stats { bottles: number; references: number; pricedReferences: number; purchaseValueCents: number | null; byColor: StatsShare[]; byRegion: StatsShare[]; byDecade: StatsShare[]; byApogee: StatsShare[]; months: Array<{ month: string; in: number; out: number }>; drinkRate: number; yearsLeft: number | null; mostDrunk: StatsRankedWine[]; topProducers: Array<{ producer: string; bottles: number }>; mostExpensive: StatsRankedWine[] }`
  - `export const getStats: () => Promise<Stats>`
  - URLs `/cave?filtre=priorite` (coche « À boire en priorité ») et `/cave?filtre=sans-apogee` (coche « Sans apogée »).

- [ ] **Step 1: Write the failing test**

Ajouter à la fin de `web/src/pages/CavePage.test.tsx` :

```tsx
it('coche « À boire en priorité » depuis l’URL', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount('/cave?filtre=priorite');
  expect(screen.getByLabelText('À boire en priorité')).toBeChecked();
  await waitFor(() => expect(getCave).toHaveBeenCalledWith({ q: '', color: undefined, includeEmpty: false, drinkSoon: true }));
});

it('coche « Sans apogée » depuis l’URL, et ignore une valeur inconnue', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([]);
  const { unmount } = mount('/cave?filtre=sans-apogee');
  expect(screen.getByLabelText('Sans apogée')).toBeChecked();
  unmount();
  mount('/cave?filtre=nimporte');
  expect(screen.getByLabelText('À boire en priorité')).not.toBeChecked();
  expect(screen.getByLabelText('Sans apogée')).not.toBeChecked();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/CavePage.test.tsx`
Expected: FAIL — les cases ne sont pas cochées.

- [ ] **Step 3: Write the implementation**

Dans `web/src/pages/CavePage.tsx`, au-dessus de `export function CavePage()` :

```tsx
/** Filtre d'apogée demandé par un lien (page Statistiques) : `?filtre=priorite` ou `?filtre=sans-apogee`. */
const FILTER_FROM_URL: Record<string, 'drinkSoon' | 'noApogee'> = { priorite: 'drinkSoon', 'sans-apogee': 'noApogee' };
```

et remplacer l'initialisation de `apogeeFilter` par :

```tsx
  const [apogeeFilter, setApogeeFilter] = useState<'' | 'drinkSoon' | 'noApogee'>(FILTER_FROM_URL[params.get('filtre') ?? ''] ?? '');
```

À la fin de `web/src/lib/api-client.ts` :

```ts
export interface StatsShare { key: string; bottles: number; share: number }
export interface StatsRankedWine { id: string; producer: string; cuvee: string | null; vintage: number | null; value: number }
export interface Stats {
  bottles: number; references: number; pricedReferences: number; purchaseValueCents: number | null;
  byColor: StatsShare[]; byRegion: StatsShare[]; byDecade: StatsShare[]; byApogee: StatsShare[];
  months: Array<{ month: string; in: number; out: number }>;
  drinkRate: number; yearsLeft: number | null;
  mostDrunk: StatsRankedWine[]; topProducers: Array<{ producer: string; bottles: number }>; mostExpensive: StatsRankedWine[];
}
export const getStats = () => apiFetch<Stats>('/stats');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api-client.ts web/src/pages/CavePage.tsx web/src/pages/CavePage.test.tsx
git commit -m "feat(cave): coche un filtre d'apogée depuis l'URL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Page Statistiques et 5e onglet

**Files:**
- Create: `web/src/pages/StatsPage.tsx`, `web/src/components/stats/BarList.tsx`, `web/src/components/stats/MonthlyChart.tsx`
- Modify: `web/src/router.tsx` (route `/stats`), `web/src/components/BottomNav.tsx` (onglet Stats), `web/src/design-tokens/tokens.css` (`--color-wine-petillant`), `web/src/styles/base.css` (classes `stats-head`, `bars`, `histo`)
- Test: `web/src/pages/StatsPage.test.tsx`

**Interfaces:**
- Consumes: `getStats`, `Stats`, `StatsShare` (Task 3) ; URLs `/cave?filtre=priorite` et `/cave?filtre=sans-apogee` (Task 3).

- [ ] **Step 1: Write the failing test**

Créer `web/src/pages/StatsPage.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { StatsPage } from './StatsPage';

afterEach(() => vi.restoreAllMocks());

const months = (overrides: Record<string, [number, number]> = {}) =>
  ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
    .map((month) => ({ month, in: overrides[month]?.[0] ?? 0, out: overrides[month]?.[1] ?? 0 }));

const base: api.Stats = {
  bottles: 12, references: 2, pricedReferences: 1, purchaseValueCents: 1240000,
  byColor: [{ key: 'ROUGE', bottles: 9, share: 0.75 }, { key: 'BLANC', bottles: 3, share: 0.25 }],
  byRegion: [{ key: 'Rhône', bottles: 9, share: 0.75 }, { key: 'Sans région', bottles: 3, share: 0.25 }],
  byDecade: [{ key: '2010', bottles: 9, share: 0.75 }, { key: 'Non millésimé', bottles: 3, share: 0.25 }],
  byApogee: [
    { key: 'TROP_JEUNE', bottles: 0, share: 0 }, { key: 'A_BOIRE', bottles: 6, share: 0.5 }, { key: 'A_BOIRE_VITE', bottles: 3, share: 0.25 },
    { key: 'PASSEE', bottles: 0, share: 0 }, { key: 'SANS_ESTIMATION', bottles: 3, share: 0.25 },
  ],
  months: months({ '2026-10': [6, 1] }), drinkRate: 0.8, yearsLeft: 1,
  mostDrunk: [{ id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', vintage: 2019, value: 3 }],
  topProducers: [{ producer: 'Domaine Tempier', bottles: 9 }],
  mostExpensive: [{ id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', vintage: 2019, value: 4800 }],
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><StatsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

it('affiche bouteilles, références et valeur au prix d’achat, avec la part valorisée', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  expect(await screen.findByText(/~12\s400\s€/)).toBeInTheDocument();
  expect(screen.getByText('sur 1 des 2 références')).toBeInTheDocument();
  expect(screen.getByText('12')).toBeInTheDocument();
});

it('dit qu’aucun prix d’achat n’est saisi', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue({ ...base, purchaseValueCents: null, pricedReferences: 0 });
  mount();
  expect(await screen.findByText('Aucun prix d’achat saisi')).toBeInTheDocument();
});

it('mène des barres d’apogée vers la cave filtrée', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  expect(await screen.findByRole('link', { name: /À boire vite/ })).toHaveAttribute('href', '/cave?filtre=priorite');
  expect(screen.getByRole('link', { name: /Sans estimation/ })).toHaveAttribute('href', '/cave?filtre=sans-apogee');
  expect(screen.queryByRole('link', { name: /^À boire 6/ })).not.toBeInTheDocument();
});

it('montre les 8 premières régions puis « Autres »', async () => {
  const byRegion = Array.from({ length: 10 }, (_, i) => ({ key: `Région ${i + 1}`, bottles: 100 - i, share: (100 - i) / 955 }));
  vi.spyOn(api, 'getStats').mockResolvedValue({ ...base, byRegion });
  mount();
  const card = (await screen.findByRole('heading', { name: 'Région' })).closest('section')!;
  expect(within(card).getByText('Région 8')).toBeInTheDocument();
  expect(within(card).queryByText('Région 9')).not.toBeInTheDocument();
  expect(within(card).getByText('Autres')).toBeInTheDocument();
  expect(within(card).getByText(/^183 ·/)).toBeInTheDocument(); // 92 + 91 bouteilles
});

it('décrit chaque mois de l’histogramme et le rythme de consommation', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  expect(await screen.findByLabelText('octobre 2026 : 6 entrées, 1 sortie')).toBeInTheDocument();
  expect(screen.getByText('En moyenne 0,8 bouteille bue par mois — environ 1 an de cave à ce rythme')).toBeInTheDocument();
});

it('sans sortie sur 12 mois, ne promet aucune durée', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue({ ...base, months: months({ '2026-03': [12, 0] }), drinkRate: 0, yearsLeft: null, mostDrunk: [] });
  mount();
  expect(await screen.findByText('Aucune bouteille sortie sur 12 mois')).toBeInTheDocument();
});

it('mène des classements vers la fiche du vin', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  const card = (await screen.findByRole('heading', { name: 'Les plus chères' })).closest('section')!;
  expect(within(card).getByRole('link', { name: /Domaine Tempier — La Tourtine 2019/ })).toHaveAttribute('href', '/cave/w1');
  expect(within(card).getByText('~48 €')).toBeInTheDocument();
});

it('dit quand la cave est vide', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue({
    ...base, bottles: 0, references: 0, pricedReferences: 0, purchaseValueCents: null, byColor: [], byRegion: [], byDecade: [],
    byApogee: base.byApogee.map((a) => ({ ...a, bottles: 0, share: 0 })), months: months(), drinkRate: 0, yearsLeft: null,
    mostDrunk: [], topProducers: [], mostExpensive: [],
  });
  mount();
  expect(await screen.findByText('Aucune bouteille en cave pour l’instant')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Apogée' })).not.toBeInTheDocument();
});

it('dit quand les statistiques ne se chargent pas', async () => {
  vi.spyOn(api, 'getStats').mockRejectedValue(new Error('boom'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les statistiques.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/StatsPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./StatsPage"`.

- [ ] **Step 3: Write the implementation**

Créer `web/src/components/stats/BarList.tsx` :

```tsx
import { Link } from 'react-router-dom';

export interface BarRow { key: string; label: string; bottles: number; share: number; color?: string; to?: string }

const pct = (share: number) => `${Math.round(share * 100)} %`;

/** Barres horizontales : libellé, nombre, part ; une ligne peut mener ailleurs. */
export function BarList({ title, rows }: { title: string; rows: BarRow[] }) {
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>{title}</h2>
      <ul className="bars">
        {rows.map((r) => {
          const body = (
            <>
              <span className="bars__text">
                <span>{r.label}</span>
                <span className="num">{`${r.bottles} · ${pct(r.share)}`}</span>
              </span>
              <span className="bars__track" aria-hidden="true">
                <span className="bars__fill" style={{ width: `${r.share * 100}%`, background: r.color }} />
              </span>
            </>
          );
          return (
            <li key={r.key}>
              {r.to ? <Link to={r.to} className="bars__row">{body}</Link> : <span className="bars__row">{body}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

Créer `web/src/components/stats/MonthlyChart.tsx` :

```tsx
const SHORT = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const ONE_DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const asDate = (month: string) => new Date(`${month}-01T00:00:00Z`);

function rhythm(drinkRate: number, yearsLeft: number | null, bottles: number): string {
  if (drinkRate === 0) return 'Aucune bouteille sortie sur 12 mois';
  const rate = `En moyenne ${ONE_DECIMAL.format(drinkRate)} ${drinkRate >= 2 ? 'bouteilles bues' : 'bouteille bue'} par mois`;
  if (yearsLeft == null || bottles === 0) return rate;
  return `${rate} — ${yearsLeft < 1 ? 'moins d’un an' : `environ ${plural(yearsLeft, 'an', 'ans')}`} de cave à ce rythme`;
}

/** Histogramme des 12 derniers mois : une barre d'entrées, une de sorties. */
export function MonthlyChart({ months, drinkRate, yearsLeft, bottles }: {
  months: Array<{ month: string; in: number; out: number }>; drinkRate: number; yearsLeft: number | null; bottles: number;
}) {
  const max = Math.max(1, ...months.flatMap((m) => [m.in, m.out]));
  const height = (n: number) => `${Math.round((n / max) * 100)}%`;
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Mouvements sur 12 mois</h2>
      <div className="histo" role="list">
        {months.map((m) => (
          <div
            key={m.month}
            role="listitem"
            className="histo__col"
            aria-label={`${LONG.format(asDate(m.month))} : ${plural(m.in, 'entrée', 'entrées')}, ${plural(m.out, 'sortie', 'sorties')}`}
          >
            <span className="histo__bars" aria-hidden="true">
              <span className="histo__bar histo__bar--in" style={{ height: height(m.in) }} />
              <span className="histo__bar histo__bar--out" style={{ height: height(m.out) }} />
            </span>
            <span className="histo__label" aria-hidden="true">{SHORT.format(asDate(m.month))}</span>
          </div>
        ))}
      </div>
      <p className="list__meta">
        <span className="histo__key histo__key--in" aria-hidden="true" /> Entrées{' '}
        <span className="histo__key histo__key--out" aria-hidden="true" /> Sorties
      </p>
      <p style={{ margin: 0 }}>{rhythm(drinkRate, yearsLeft, bottles)}</p>
    </section>
  );
}
```

Créer `web/src/pages/StatsPage.tsx` :

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { TopBar } from '../components/TopBar';
import { BarList, BarRow } from '../components/stats/BarList';
import { MonthlyChart } from '../components/stats/MonthlyChart';
import { getStats, StatsRankedWine, StatsShare } from '../lib/api-client';

const COLOR_LABEL: Record<string, string> = { ROUGE: 'Rouge', BLANC: 'Blanc', ROSE: 'Rosé', PETILLANT: 'Pétillant' };
const COLOR_VAR: Record<string, string> = {
  ROUGE: 'var(--color-wine-rouge)', BLANC: 'var(--color-wine-blanc)', ROSE: 'var(--color-wine-rose)', PETILLANT: 'var(--color-wine-petillant)',
};
const APOGEE_LABEL: Record<string, string> = {
  TROP_JEUNE: 'Trop jeune', A_BOIRE: 'À boire', A_BOIRE_VITE: 'À boire vite', PASSEE: 'Passée', SANS_ESTIMATION: 'Sans estimation',
};
const APOGEE_LINK: Record<string, string> = {
  A_BOIRE_VITE: '/cave?filtre=priorite', PASSEE: '/cave?filtre=priorite', SANS_ESTIMATION: '/cave?filtre=sans-apogee',
};
const REGIONS_SHOWN = 8;

const EUROS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const euros = (cents: number) => `~${EUROS.format(Math.round(cents / 100))} €`;
const wineLabel = (w: StatsRankedWine) => `${w.producer}${w.cuvee ? ` — ${w.cuvee}` : ''} ${w.vintage ?? 'NV'}`;
const bottlesText = (n: number) => `${n} ${n > 1 ? 'bouteilles' : 'bouteille'}`;

/** Les `count` premières, puis une ligne « Autres » qui totalise le reste. */
function topWithOthers(rows: StatsShare[], count: number): StatsShare[] {
  if (rows.length <= count) return rows;
  const rest = rows.slice(count);
  return [...rows.slice(0, count), {
    key: 'Autres', bottles: rest.reduce((s, r) => s + r.bottles, 0), share: rest.reduce((s, r) => s + r.share, 0),
  }];
}

const plain = (rows: StatsShare[]): BarRow[] => rows.map((r) => ({ ...r, label: r.key }));

function RankList({ title, items }: { title: string; items: Array<{ key: string; label: string; value: string; to?: string }> }) {
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>{title}</h2>
      {items.length === 0 && <p className="list__meta">Rien à classer pour l’instant.</p>}
      <ol className="bars">
        {items.map((i) => (
          <li key={i.key} className="bars__text">
            {i.to ? <Link to={i.to}>{i.label}</Link> : <span>{i.label}</span>}
            <span className="num">{i.value}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function StatsPage() {
  const q = useQuery({ queryKey: ['stats'], queryFn: getStats });
  const s = q.data;
  const anyMovement = s?.months.some((m) => m.in > 0 || m.out > 0) ?? false;
  return (
    <>
      <TopBar title="Statistiques" />
      <main className="page">
        {q.isPending && <p className="centered">Calcul…</p>}
        {q.isError && <p role="alert" className="text-error">Impossible de charger les statistiques.</p>}
        {s && s.bottles === 0 && <p className="centered">Aucune bouteille en cave pour l’instant</p>}
        {s && s.bottles > 0 && (
          <>
            <section className="card stats-head">
              <span><span className="stats-head__value num">{s.bottles}</span><span className="list__meta">bouteilles</span></span>
              <span><span className="stats-head__value num">{s.references}</span><span className="list__meta">références</span></span>
              <span>
                <span className="stats-head__value num">{s.purchaseValueCents == null ? '—' : euros(s.purchaseValueCents)}</span>
                <span className="list__meta">au prix d’achat</span>
              </span>
              {s.purchaseValueCents == null && <span className="list__meta stats-head__note">Aucun prix d’achat saisi</span>}
              {s.purchaseValueCents != null && s.pricedReferences < s.references && (
                <span className="list__meta stats-head__note">{`sur ${s.pricedReferences} des ${s.references} références`}</span>
              )}
            </section>
            <BarList
              title="Apogée"
              rows={s.byApogee.map((r) => ({ ...r, label: APOGEE_LABEL[r.key] ?? r.key, to: r.bottles > 0 ? APOGEE_LINK[r.key] : undefined }))}
            />
            <BarList title="Couleur" rows={s.byColor.map((r) => ({ ...r, label: COLOR_LABEL[r.key] ?? r.key, color: COLOR_VAR[r.key] }))} />
            <BarList title="Région" rows={plain(topWithOthers(s.byRegion, REGIONS_SHOWN))} />
            <BarList title="Millésime" rows={s.byDecade.map((r) => ({ ...r, label: r.key === 'Non millésimé' ? r.key : `Années ${r.key}` }))} />
          </>
        )}
        {s && (s.bottles > 0 || anyMovement) && (
          <MonthlyChart months={s.months} drinkRate={s.drinkRate} yearsLeft={s.yearsLeft} bottles={s.bottles} />
        )}
        {s && s.bottles > 0 && (
          <>
            <RankList title="Les plus bus" items={s.mostDrunk.map((w) => ({ key: w.id, label: wineLabel(w), value: bottlesText(w.value), to: `/cave/${w.id}` }))} />
            <RankList title="Producteurs" items={s.topProducers.map((p) => ({ key: p.producer, label: p.producer, value: bottlesText(p.bottles) }))} />
            <RankList title="Les plus chères" items={s.mostExpensive.map((w) => ({ key: w.id, label: wineLabel(w), value: euros(w.value), to: `/cave/${w.id}` }))} />
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
```

Note : la barre « Apogée » d'un statut à 0 bouteille n'a pas de lien (rien à montrer dans la cave). Le libellé de la décennie est « Années 2010 ».

Dans `web/src/router.tsx`, importer `StatsPage` (`import { StatsPage } from './pages/StatsPage';`, trié avec les autres) et ajouter, après la route `/journal` :

```tsx
          { path: '/stats', element: <StatsPage /> },
```

Dans `web/src/components/BottomNav.tsx`, ajouter le 5e onglet en dernier :

```tsx
  { to: '/stats', icon: 'bar_chart', label: 'Stats', soon: false },
```

Dans `web/src/design-tokens/tokens.css`, après `--color-wine-rose: #E8A598;` :

```css
  --color-wine-petillant: #D8CFA8;
```

À la fin de `web/src/styles/base.css` :

```css
.stats-head { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-sm); text-align: center; }
.stats-head > span { display: flex; flex-direction: column; }
.stats-head__value { font: 600 22px var(--font-serif); color: var(--color-primary); }
.stats-head__note { grid-column: 1 / -1; }

.bars { list-style: none; margin: var(--space-sm) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
.bars__row { display: block; color: inherit; text-decoration: none; }
a.bars__row .bars__text > span:first-child { text-decoration: underline; text-underline-offset: 3px; }
.bars__text { display: flex; justify-content: space-between; gap: var(--space-sm); font-size: 13px; }
.bars__track { display: block; height: 8px; margin-top: 2px; border-radius: 4px; background: var(--color-surface-container-low); overflow: hidden; }
.bars__fill { display: block; height: 100%; border-radius: 4px; background: var(--color-primary); }

.histo { display: flex; align-items: stretch; gap: 4px; height: 120px; margin-top: var(--space-sm); }
.histo__col { flex: 1; display: flex; flex-direction: column; align-items: center; }
.histo__bars { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 1px; }
.histo__bar { width: 45%; border-radius: 2px 2px 0 0; }
.histo__bar--in, .histo__key--in { background: var(--color-primary-action); }
.histo__bar--out, .histo__key--out { background: var(--color-wine-rouge); }
.histo__label { font-size: 10px; color: var(--color-secondary); margin-top: 2px; }
.histo__key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet`
Expected: PASS. Si un test existant compte les onglets de la barre (chercher `Navigation principale` ou `bottomnav` dans `web/src`), l'adapter à cinq onglets.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/StatsPage.tsx web/src/pages/StatsPage.test.tsx web/src/components/stats web/src/router.tsx web/src/components/BottomNav.tsx web/src/design-tokens/tokens.css web/src/styles/base.css
git commit -m "feat(stats): page Statistiques et onglet Stats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation et essai dans le navigateur

**Files:**
- Modify: `README.md` (sections « État », « Fonctionnalités », « Limites »)

- [ ] **Step 1: Mettre à jour le README**

Dans `README.md` :
- ligne « **État** » : ajouter « lot 4a (statistiques) » aux lots livrés ;
- dans « Fonctionnalités », après le paragraphe **Mesure « zéro saisie »**, ajouter :

```markdown
**Statistiques.** Le 5e onglet *Stats* ouvre une page calculée à chaque
lecture (`GET /api/stats`, tout compte actif) : bouteilles, références et
**valeur au prix d'achat** (stock × dernier prix d'achat saisi, la même règle
que l'export ; « sur N des M références » quand des prix manquent, « Aucun prix
d'achat saisi » sinon) ; répartition du stock par **apogée** (les barres *À
boire vite*, *Passée* et *Sans estimation* ouvrent l'onglet Cave déjà filtré),
par **couleur**, par **région** (8 premières puis *Autres*) et par **décennie
de millésime** ; **mouvements sur 12 mois** (entrées et sorties par mois, heure
de Paris ; annulations et inventaires exclus), avec le rythme moyen de
consommation et la durée de cave qu'il donne ; et trois **classements** : les
vins les plus bus sur 12 mois, les producteurs les plus présents, les
bouteilles les plus chères au prix d'achat.
```

- dans « Limites », ajouter :

```markdown
- **Statistiques au prix d'achat seulement** : la valeur au prix du marché et
  l'écart achat / marché attendent la cote iDealwine (lot 2c, reporté). La
  fenêtre des mouvements est fixe (12 mois).
```

- [ ] **Step 2: Essai dans le navigateur à 375 px**

Construire et lancer l'api sur `cave_test` (port 3000), lancer le serveur web (`.claude/launch.json`, configuration `web`), se connecter avec le compte de secours local, ouvrir `/stats` à 375 px : vérifier que les cinq onglets tiennent sur une ligne sans débordement, que les cartes s'affichent, et qu'un tap sur *À boire vite* ouvre l'onglet Cave avec *À boire en priorité* coché. Arrêter l'api ensuite.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: statistiques dans le README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
