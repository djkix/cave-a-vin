import type { CaveRow } from './api-client';
import { groupByPlace, whereLabel } from './drink-soon';

const wine = (id: string, max: number, places: CaveRow['places'], rating?: number): CaveRow => ({
  id, producer: `Domaine ${id}`, cuvee: null, appellationRaw: 'Bandol', vintage: 2015, color: 'ROUGE', formatCl: 75,
  referencePhotoId: null, quantity: (places ?? []).reduce((s, p) => s + p.quantity, 0),
  apogee: { min: 2018, max, confidence: 'MOYENNE', status: 'A_BOIRE_VITE', reason: null, source: 'REGLE' },
  rating: rating == null ? null : { value: rating, ratedAt: '', ratedBy: null }, places,
});

it('regroupe par emplacement, « Sans emplacement » en dernier, un vin à deux endroits dans les deux', () => {
  const groups = groupByPlace([
    wine('a', 2026, [{ id: 'g', label: 'Garage', quantity: 1 }, { id: null, label: 'Sans emplacement', quantity: 2 }]),
    wine('b', 2027, [{ id: 'c1', label: 'Cave 1 / A', quantity: 3 }]),
  ]);
  expect(groups.map((g) => g.label)).toEqual(['Cave 1 / A', 'Garage', 'Sans emplacement']);
  expect(groups[1].wines.map((w) => [w.wine.id, w.quantity])).toEqual([['a', 1]]);
  expect(groups[2].wines.map((w) => [w.wine.id, w.quantity])).toEqual([['a', 2]]);
});

it('dans un groupe, la fin d’apogée la plus proche d’abord, puis la meilleure note', () => {
  const at = (q: number) => [{ id: 'g', label: 'Garage', quantity: q }];
  const [g] = groupByPlace([wine('tard', 2027, at(1), 18), wine('noteBasse', 2026, at(1), 12), wine('noteHaute', 2026, at(1), 17)]);
  expect(g.wines.map((w) => w.wine.id)).toEqual(['noteHaute', 'noteBasse', 'tard']);
});

it('un vin sans endroit connu compte comme « Sans emplacement »', () => {
  const w = { ...wine('x', 2026, undefined), quantity: 2 };
  expect(groupByPlace([w])).toEqual([{ label: 'Sans emplacement', zoneId: null, wines: [{ wine: w, quantity: 2 }] }]);
  expect(whereLabel(w)).toBe('Sans emplacement');
  expect(whereLabel(wine('y', 2026, [{ id: 'g', label: 'Garage', quantity: 1 }, { id: 'c', label: 'Cave 1 / A', quantity: 1 }]))).toBe('Garage, Cave 1 / A');
});

it('chaque groupe porte la zone de son emplacement (indication et photo dans l’en-tête)', () => {
  const groups = groupByPlace([
    wine('a', 2026, [{ id: 'g', label: 'Garage', quantity: 1, zoneId: 'z-garage' }, { id: 'b', label: 'B', quantity: 1, zoneId: null }]),
  ]);
  expect(groups.map((g) => [g.label, g.zoneId])).toEqual([['B', null], ['Garage', 'z-garage']]);
});
