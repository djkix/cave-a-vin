import { EXTRACTION_JSON_SCHEMA_DESCRIPTION, parseExtraction, safeParseExtraction } from './extraction-schema';

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

describe('parseExtraction — cadre de l’étiquette', () => {
  it('accepte une ancienne lecture sans champ « etiquette » (labelBox null)', () => {
    expect(parseExtraction(valid).labelBox).toBeNull();
  });

  it('accepte « etiquette » à null', () => {
    expect(parseExtraction({ ...valid, etiquette: null }).labelBox).toBeNull();
  });

  it('rend le cadre [ymin, xmin, ymax, xmax] tel que lu', () => {
    expect(parseExtraction({ ...valid, etiquette: [100, 200, 800, 900] }).labelBox).toEqual([100, 200, 800, 900]);
  });

  it('un cadre mal formé ne rend pas la lecture illisible : il vaut null', () => {
    expect(parseExtraction({ ...valid, etiquette: [1, 2, 3] }).labelBox).toBeNull();
    expect(parseExtraction({ ...valid, etiquette: 'haut' }).labelBox).toBeNull();
    expect(safeParseExtraction({ ...valid, etiquette: [1, 'a', 3, 4] })?.producer.value).toBe('Domaine Tempier');
  });
});

describe('EXTRACTION_JSON_SCHEMA_DESCRIPTION', () => {
  it('demande le cadre de l’étiquette en coordonnées 0..1000, ou null', () => {
    expect(EXTRACTION_JSON_SCHEMA_DESCRIPTION).toContain('"etiquette"');
    expect(EXTRACTION_JSON_SCHEMA_DESCRIPTION).toMatch(/\[ymin, xmin, ymax, xmax\]/);
    expect(EXTRACTION_JSON_SCHEMA_DESCRIPTION).toContain('0..1000');
  });
});
