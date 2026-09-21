import { parseExtraction } from './extraction-schema';

const valid = {
  producteur: { value: 'Domaine Tempier', confidence: 0.98 },
  cuvee: { value: 'La Tourtine', confidence: 0.95 },
  appellation: { value: 'Bandol', confidence: 0.97 },
  millesime: { value: 2019, confidence: 0.94 },
  couleur: { value: 'rouge', confidence: 0.99 },
  format_cl: { value: 75, confidence: 0.9 },
  degre: { value: 14.5, confidence: 0.8 },
  pays_region: { value: 'Provence', confidence: 0.7 },
  nb_cols_carton: { value: 6, confidence: 0.85 },
  confiance_globale: 0.93,
};

describe('parseExtraction', () => {
  it('maps the French JSON contract to WineExtraction', () => {
    const e = parseExtraction(valid);
    expect(e.producer.value).toBe('Domaine Tempier');
    expect(e.color.value).toBe('ROUGE');
    expect(e.bottlesPerCase.value).toBe(6);
    expect(e.globalConfidence).toBe(0.93);
  });

  it('accepts nulls (a field the model could not read) but rejects invented enum values', () => {
    expect(parseExtraction({ ...valid, millesime: { value: null, confidence: 0 } }).vintage.value).toBeNull();
    expect(() => parseExtraction({ ...valid, couleur: { value: 'orange', confidence: 0.9 } })).toThrow();
  });

  it('rejects an implausible vintage', () => {
    expect(() => parseExtraction({ ...valid, millesime: { value: 1492, confidence: 0.9 } })).toThrow();
  });
});
