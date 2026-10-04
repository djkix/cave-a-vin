import { InStockWine, rankExitCandidates } from './exit-ranking';

function w(id: string, producer: string, cuvee: string | null, appellationRaw: string, vintage: number | null, quantity = 3): InStockWine {
  return { wine: { id, producer, cuvee, appellationRaw, vintage, color: 'ROUGE', formatCl: 75 }, quantity, referencePhotoId: `ref-${id}` };
}

const cave: InStockWine[] = [
  w('tempier19', 'Domaine Tempier', 'La Tourtine', 'Bandol', 2019),
  w('tempier20', 'Domaine Tempier', 'La Tourtine', 'Bandol', 2020),
  w('tempierMig', 'Domaine Tempier', 'La Migoua', 'Bandol', 2019),
  w('beaucastel', 'Château de Beaucastel', null, 'Châteauneuf-du-Pape', 2016),
  w('gauby', 'Domaine Gauby', 'Vieilles Vignes', 'Côtes Catalanes', 2018),
  w('vide', 'Domaine Vide', null, 'Chablis', 2020, 0),
  w('margaux', 'Château Margaux', null, 'Margaux', 2010),
  w('palmer', 'Château Palmer', null, 'Margaux', 2010),
];
const ids = (r: ReturnType<typeof rankExitCandidates>) => r.candidates.map((c: any) => c.wine.id);

describe('rankExitCandidates', () => {
  it('reconnait le bon millesime quand l\'annee est lue', () => {
    const r = rankExitCandidates({ producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: 2019 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('tempier19');
    expect(ids(r)).not.toContain('tempier20');
  });

  it('propose les deux millesimes quand l\'annee est illisible', () => {
    const r = rankExitCandidates({ producer: 'Tempier', cuvee: 'Tourtine', appellation: 'Bandol', vintage: null }, cave);
    expect(r.outcome).toBe('SEVERAL');
    expect(ids(r).slice(0, 2).sort()).toEqual(['tempier19', 'tempier20']);
  });

  it('ignore Chateau, les accents et les tirets', () => {
    const r = rankExitCandidates({ producer: 'Beaucastel', cuvee: null, appellation: 'Chateauneuf du Pape', vintage: 2016 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('beaucastel');
  });

  it('ne trouve rien pour un vin absent de la cave', () => {
    const r = rankExitCandidates({ producer: 'Domaine Rostaing', cuvee: 'Cote Blonde', appellation: 'Cote-Rotie', vintage: 2017 }, cave);
    expect(r).toEqual({ outcome: 'NONE', candidates: [] });
  });

  it('distingue deux cuvees du meme domaine', () => {
    const r = rankExitCandidates({ producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol', vintage: 2019 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('tempierMig');
  });

  it('ne propose jamais un vin a zero bouteille', () => {
    const r = rankExitCandidates({ producer: 'Domaine Vide', cuvee: null, appellation: 'Chablis', vintage: 2020 }, cave);
    expect(ids(r)).not.toContain('vide');
  });

  it('se contente du nom quand l\'appellation est illisible', () => {
    const r = rankExitCandidates({ producer: 'Domaine Gauby', cuvee: 'Vieilles Vignes', appellation: null, vintage: 2018 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('gauby');
  });

  it('departage deux chateaux de la meme appellation par leur nom', () => {
    const r = rankExitCandidates({ producer: 'Chateau Palmer', cuvee: null, appellation: 'Margaux', vintage: 2010 }, cave);
    expect(ids(r)[0]).toBe('palmer');
  });

  it('montre en vignette un candidat seul mais peu sur, sans le confirmer d\'office', () => {
    const r = rankExitCandidates({ producer: 'Tempier', cuvee: null, appellation: null, vintage: null }, [w('t', 'Domaine Tempier', 'La Tourtine', 'Bandol', 2019)]);
    expect(r.candidates).toHaveLength(1);
    expect(r.outcome).toBe('SEVERAL');
  });

  it('ne renvoie jamais plus de quatre candidats', () => {
    const many = [2015, 2016, 2017, 2018, 2019, 2020].map((y) => w(`t${y}`, 'Domaine Tempier', 'La Tourtine', 'Bandol', y));
    const r = rankExitCandidates({ producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: null }, many);
    expect(r.candidates).toHaveLength(4);
  });

  it('ne trouve rien quand le modele n\'a rien lu', () => {
    expect(rankExitCandidates({ producer: null, cuvee: null, appellation: null, vintage: null }, cave).outcome).toBe('NONE');
  });
});
