import { Apogee, ApogeeStatus } from '../apogee/apogee';
import { computeStats, lastMonths, monthKey, PRICE_KEYS, Stats, statsForRole, StatsMovement, StatsWine, ViewerStats } from './stats';

const NOW = new Date('2026-10-15T12:00:00Z');
const ap = (status: ApogeeStatus | null): Apogee => ({ min: null, max: null, confidence: null, status, reason: null, source: null });
const wine = (id: string, over: Partial<StatsWine> = {}): StatsWine => ({
  id, producer: `P-${id}`, cuvee: null, vintage: 2019, color: 'ROUGE', region: 'Provence', quantity: 1, apogee: ap('A_BOIRE'), rating: null, ...over,
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

  it("franchit le changement d'année", () => {
    expect(lastMonths(new Date('2026-01-10T12:00:00Z'), 3)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('computeStats — valeur et volume', () => {
  it("valorise au dernier prix d'achat et compte à part les vins sans prix", () => {
    const wines = [wine('w1', { quantity: 6 }), wine('w2', { quantity: 2 }), wine('w3', { quantity: 0 })];
    const movements = [
      mv('w1', 'IN', 6, '2026-01-10T10:00:00Z', { priceUnitCents: 4000 }),
      mv('w1', 'IN', 6, '2026-02-10T10:00:00Z', { priceUnitCents: 4800 }),
    ];
    const s = computeStats({ wines, movements }, NOW);
    expect(s).toMatchObject({ bottles: 8, references: 2, pricedReferences: 1, purchaseValueCents: 6 * 4800 });
  });

  it("ignore le prix d'une entrée annulée", () => {
    const cancelledIn = mv('w1', 'IN', 1, '2026-03-10T10:00:00Z', { priceUnitCents: 9000 });
    const movements = [
      mv('w1', 'IN', 6, '2026-01-10T10:00:00Z', { priceUnitCents: 4000 }),
      cancelledIn,
      mv('w1', 'ADJUST', -1, '2026-03-10T11:00:00Z', { reversesId: cancelledIn.id }),
    ];
    const s = computeStats({ wines: [wine('w1', { quantity: 6 })], movements }, NOW);
    expect(s.purchaseValueCents).toBe(6 * 4000);
  });

  it("n'annonce aucune valeur quand aucun prix n'est connu", () => {
    const s = computeStats({ wines: [wine('w1', { quantity: 3 })], movements: [] }, NOW);
    expect(s.purchaseValueCents).toBeNull();
    expect(s.pricedReferences).toBe(0);
  });
});

describe('computeStats — valeur à la cote', () => {
  it('somme cote × stock des vins en stock cotés, compte les références cotées sur les références en stock, valeur de cession', () => {
    const wines = [wine('w1', { quantity: 6 }), wine('w2', { quantity: 2 }), wine('w3', { quantity: 0 }), wine('w4', { quantity: 1 })];
    const quotes = [{ wineId: 'w1', coteCents: 8500 }, { wineId: 'w3', coteCents: 99999 }, { wineId: 'w4', coteCents: 333 }];
    const s = computeStats({ wines, movements: [], quotes }, NOW);
    expect(s).toMatchObject({ quotedValueCents: 6 * 8500 + 333, quotedReferences: 2, quotableReferences: 3 });
    expect(s.cessionValueCents).toBe(Math.round((6 * 8500 + 333) / 1.16));
  });

  it("sans cote : aucune valeur, 0 référence cotée", () => {
    const s = computeStats({ wines: [wine('w1', { quantity: 3 })], movements: [] }, NOW);
    expect(s).toMatchObject({ quotedValueCents: null, cessionValueCents: null, quotedReferences: 0, quotableReferences: 1 });
  });

  it('toutes ces clés sont des clés de prix (retirées au membre)', () => {
    for (const k of ['quotedValueCents', 'quotedReferences', 'quotableReferences', 'cessionValueCents']) expect(PRICE_KEYS).toContain(k);
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

  it("par statut d'apogée, dans l'ordre fixe, y compris les statuts vides", () => {
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

  it('place un mouvement au tout début du mois le plus ancien, et exclut celui de la veille', () => {
    const movements = [
      // 2025-10-31T23:30:00Z = 1 nov. 2025 00 h 30 à Paris : dans la fenêtre, mois 2025-11.
      mv('w1', 'OUT', -1, '2025-10-31T23:30:00Z'),
      // 2025-10-31T22:30:00Z = 31 oct. 2025 23 h 30 à Paris : hors fenêtre (mois 2025-10).
      mv('w1', 'OUT', -1, '2025-10-31T22:30:00Z'),
    ];
    const s = computeStats({ wines: [wine('w1', { quantity: 5 })], movements }, NOW);
    expect(s.months.find((m) => m.month === '2025-11')).toEqual({ month: '2025-11', in: 0, out: 1 });
  });

  it('sans sortie, ni rythme ni durée', () => {
    const s = computeStats({ wines: [wine('w1', { quantity: 5 })], movements: [mv('w1', 'IN', 5, '2026-05-01T10:00:00Z')] }, NOW);
    expect(s.drinkRate).toBe(0);
    expect(s.yearsLeft).toBeNull();
  });
});

describe('computeStats — déplacements', () => {
  it('un déplacement (MOVE) n’est ni une entrée ni une sortie : flux, rythme, durée et « les plus bus »', () => {
    const wines = [wine('w1', { quantity: 4 })];
    const movements = [
      mv('w1', 'IN', 4, '2026-09-01T10:00:00Z'),
      mv('w1', 'MOVE', -3, '2026-09-05T10:00:00Z'),
      mv('w1', 'MOVE', 3, '2026-09-05T10:00:00Z'),
    ];
    const s = computeStats({ wines, movements }, NOW);
    expect(s.months.find((f) => f.month === '2026-09')).toEqual({ month: '2026-09', in: 4, out: 0 });
    expect(s.drinkRate).toBe(0);
    expect(s.yearsLeft).toBeNull();
    expect(s.mostDrunk).toEqual([]);
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

  it("les bouteilles en stock les plus chères au dernier prix d'achat", () => {
    const wines = [wine('a', { quantity: 1 }), wine('b', { quantity: 1 }), wine('c', { quantity: 0 })];
    const movements = [
      mv('a', 'IN', 1, '2026-01-01T10:00:00Z', { priceUnitCents: 2000 }),
      mv('b', 'IN', 1, '2026-01-01T10:00:00Z', { priceUnitCents: 9000 }),
      mv('c', 'IN', 1, '2026-01-01T10:00:00Z', { priceUnitCents: 50000 }),
    ];
    expect(computeStats({ wines, movements }, NOW).mostExpensive.map((w) => [w.id, w.value])).toEqual([['b', 9000], ['a', 2000]]);
  });

  it('les mieux notés, en stock ou non, départagés par producteur, limités à 5', () => {
    const wines = [
      wine('a', { producer: 'Domaine A', rating: 15, quantity: 0 }),
      wine('b', { producer: 'Domaine B', rating: 18.5 }),
      wine('c', { producer: 'Domaine C', rating: 15 }),
      wine('d', { producer: 'Domaine D', rating: null }),
      wine('e', { producer: 'Domaine E', rating: 12 }),
      wine('f', { producer: 'Domaine F', rating: 11 }),
      wine('g', { producer: 'Domaine G', rating: 10 }),
    ];
    expect(computeStats({ wines, movements: [] }, NOW).bestRated.map((w) => [w.id, w.value])).toEqual([
      ['b', 18.5], ['a', 15], ['c', 15], ['e', 12], ['f', 11],
    ]);
  });
});

describe('statsForRole', () => {
  const stats = computeStats({ wines: [], movements: [] }, NOW);

  it('retire au VIEWER chaque clé de PRICE_KEYS, et rien d’autre', () => {
    const viewer = statsForRole(stats, 'VIEWER');
    for (const k of PRICE_KEYS) expect(viewer).not.toHaveProperty(k);
    expect(Object.keys(viewer).sort()).toEqual(Object.keys(stats).filter((k) => !(PRICE_KEYS as readonly string[]).includes(k)).sort());
    expect(stats).toHaveProperty('purchaseValueCents');
  });

  it('rend les statistiques complètes au seul OWNER (typage compris)', () => {
    const owner: Stats = statsForRole(stats, 'OWNER');
    expect(owner).toBe(stats);
    const viewer: ViewerStats = statsForRole(stats, 'VIEWER');
    // @ts-expect-error -- un VIEWER ne peut pas recevoir le type Stats complet
    const leaked: Stats = statsForRole(stats, 'VIEWER');
    expect([viewer, leaked]).toHaveLength(2);
  });
});
