import { correctedFields, READ_FIELDS, summarize } from './reading-quality';

const raw = (over: Record<string, unknown> = {}) => ({
  producteur: { value: 'Château de Beaucastel', confidence: 0.9 },
  cuvee: { value: null, confidence: 0 },
  appellation: { value: 'Châteauneuf-du-Pape', confidence: 0.9 },
  millesime: { value: 2016, confidence: 0.8 },
  couleur: { value: 'rouge', confidence: 0.9 },
  format_cl: { value: 75, confidence: 0.9 },
  degre: { value: null, confidence: 0 },
  pays_region: { value: null, confidence: 0 },
  nb_cols_carton: { value: null, confidence: 0 },
  confiance_globale: 0.85,
  ...over,
});
const confirmed = (over: Record<string, unknown> = {}) => ({
  producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016, color: 'ROUGE', formatCl: 75, ...over,
});

describe('correctedFields', () => {
  it('ne compte rien quand la fiche confirmée est celle pré-remplie', () => {
    expect(correctedFields(raw(), confirmed())).toEqual([]);
  });

  it('compte chaque champ modifié', () => {
    expect(correctedFields(raw(), confirmed({ vintage: 2017, color: 'BLANC' }))).toEqual(['vintage', 'color']);
  });

  it('ignore les espaces autour, mais pas les majuscules ni les accents', () => {
    expect(correctedFields(raw(), confirmed({ producer: '  Château de Beaucastel ' }))).toEqual([]);
    expect(correctedFields(raw(), confirmed({ producer: 'chateau de beaucastel' }))).toEqual(['producer']);
  });

  it('une cuvée vide confirmée vide n’est pas une correction, une cuvée ajoutée en est une', () => {
    expect(correctedFields(raw(), confirmed({ cuvee: '' }))).toEqual([]);
    expect(correctedFields(raw(), confirmed({ cuvee: 'Hommage' }))).toEqual(['cuvee']);
  });

  it('garder les valeurs par défaut d’un champ non lu n’est pas une correction', () => {
    const r = raw({ couleur: { value: null, confidence: 0 }, format_cl: { value: null, confidence: 0 } });
    expect(correctedFields(r, confirmed({ color: 'ROUGE', formatCl: 75 }))).toEqual([]);
    expect(correctedFields(r, confirmed({ color: 'ROSE', formatCl: 150 }))).toEqual(['color', 'formatCl']);
  });

  it('une lecture absente ou illisible pré-remplit un formulaire vide : tout ce qui est saisi compte', () => {
    expect(correctedFields(null, confirmed())).toEqual(['producer', 'appellationRaw', 'vintage']);
    expect(correctedFields({ n: 'importe quoi' }, confirmed())).toEqual(['producer', 'appellationRaw', 'vintage']);
  });
});

describe('summarize', () => {
  it('rapporte le taux global et par champ', () => {
    const s = summarize([['vintage'], [], ['vintage', 'producer']]);
    expect(s.entries).toBe(3);
    expect(s.rate).toBeCloseTo(3 / 18);
    expect(s.fields).toHaveLength(READ_FIELDS.length);
    expect(s.fields.find((f) => f.field === 'vintage')).toEqual({ field: 'vintage', corrected: 2, rate: 2 / 3 });
    expect(s.fields.find((f) => f.field === 'cuvee')).toEqual({ field: 'cuvee', corrected: 0, rate: 0 });
  });

  it('ne divise pas par zéro sans entrée', () => {
    expect(summarize([])).toMatchObject({ entries: 0, rate: null });
    expect(summarize([]).fields[0].rate).toBeNull();
  });
});
