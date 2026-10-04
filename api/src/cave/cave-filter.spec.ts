import { CaveRow, filterCave } from './cave-filter';

const row = (id: string, producer: string, appellationRaw: string, quantity: number, extra: Partial<CaveRow> = {}): CaveRow => ({
  id, producer, cuvee: null, appellationRaw, vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity, ...extra,
});

const rows = [
  row('a', 'Château de Beaucastel', 'Châteauneuf-du-Pape', 3),
  row('b', 'Domaine Tempier', 'Bandol', 0),
  row('c', 'Domaine Leflaive', 'Puligny-Montrachet', 2, { color: 'BLANC', cuvee: 'Clavoillon' }),
];

describe('filterCave', () => {
  it('masque les vins épuisés par défaut', () => {
    expect(filterCave(rows, {}).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('les montre sur demande', () => {
    expect(filterCave(rows, { includeEmpty: true }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('cherche sans tenir compte des accents ni de la casse', () => {
    expect(filterCave(rows, { q: 'chateauneuf' }).map((r) => r.id)).toEqual(['a']);
  });

  it('cherche aussi dans la cuvée', () => {
    expect(filterCave(rows, { q: 'CLAVOILLON' }).map((r) => r.id)).toEqual(['c']);
  });

  it('exige tous les mots de la recherche', () => {
    expect(filterCave(rows, { q: 'leflaive puligny' }).map((r) => r.id)).toEqual(['c']);
    expect(filterCave(rows, { q: 'leflaive bandol' })).toEqual([]);
  });

  it('filtre par couleur', () => {
    expect(filterCave(rows, { color: 'BLANC' }).map((r) => r.id)).toEqual(['c']);
  });
});
