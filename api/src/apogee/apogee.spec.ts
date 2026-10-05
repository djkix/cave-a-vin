import { apogeeStatus, ApogeeWineInput, compileApogeeRules, EMPTY_APOGEE_RULES, estimateApogee, isDrinkSoon, sortByApogeeEnd } from './apogee';

const YEAR = 2026;
const wine = (over: Partial<ApogeeWineInput> = {}): ApogeeWineInput => ({
  vintage: 2016, color: 'ROUGE', appellationId: 'cdp', region: 'Rhone', referenceGuardMin: 8, referenceGuardMax: 20,
  apogeeMin: null, apogeeMax: null, apogeeSource: null, ...over,
});
const rules = (over: Partial<Parameters<typeof compileApogeeRules>[0]> = {}) =>
  compileApogeeRules({ guardOverrides: [], vintageQualities: [], ...over });

describe('estimateApogee — exemples de référence de la spécification', () => {
  it('Châteauneuf-du-Pape 2016 non qualifié : 2024-2036, confiance faible', () => {
    expect(estimateApogee(wine(), EMPTY_APOGEE_RULES, YEAR)).toEqual({
      min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE',
    });
  });

  it('Rhone 2016 grand millesime : 2026-2040, confiance moyenne', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhone', year: 2016, quality: 'GRAND' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2026, max: 2040, confidence: 'MOYENNE' });
  });

  it('Rhone 2016 faible : 2023-2033, confiance moyenne', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhone', year: 2016, quality: 'FAIBLE' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2023, max: 2033, confidence: 'MOYENNE' });
  });

  it('un millesime qualifie "moyen" donne la meme fourchette mais une confiance moyenne', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhone', year: 2016, quality: 'MOYEN' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2024, max: 2036, confidence: 'MOYENNE' });
  });

  it('Rose de Provence 2023 : 2024-2026', () => {
    const w = wine({ vintage: 2023, color: 'ROSE', appellationId: 'provence', region: 'Provence', referenceGuardMin: 1, referenceGuardMax: 3 });
    expect(estimateApogee(w, EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2024, max: 2026 });
  });

  it('Alsace 2020 rose : plafonne a 1-3 ans (2021-2023), pas la garde de l\'appellation 1-8', () => {
    const w = wine({ vintage: 2020, color: 'ROSE', appellationId: 'alsace', region: 'Alsace', referenceGuardMin: 1, referenceGuardMax: 8 });
    expect(estimateApogee(w, EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2021, max: 2023 });
  });

  it('Alsace 2020 rose avec ajustement Alsace/ROSE 2-4 : 2022-2024 (l\'ajustement par couleur passe avant le rose)', () => {
    const w = wine({ vintage: 2020, color: 'ROSE', appellationId: 'alsace', region: 'Alsace', referenceGuardMin: 1, referenceGuardMax: 8 });
    const r = rules({ guardOverrides: [{ appellationId: 'alsace', color: 'ROSE', min: 2, max: 4 }] });
    expect(estimateApogee(w, r, YEAR)).toMatchObject({ min: 2022, max: 2024 });
  });

  it('Meursault 2019 blanc avec ajustement toutes couleurs 4-12 : 2023-2031', () => {
    const w = wine({ vintage: 2019, color: 'BLANC', appellationId: 'meursault', region: 'Bourgogne', referenceGuardMin: 3, referenceGuardMax: 10 });
    const r = rules({ guardOverrides: [{ appellationId: 'meursault', color: null, min: 4, max: 12 }] });
    expect(estimateApogee(w, r, YEAR)).toMatchObject({ min: 2023, max: 2031 });
  });

  it('vin non millesime : aucune estimation', () => {
    expect(estimateApogee(wine({ vintage: null }), EMPTY_APOGEE_RULES, YEAR)).toEqual({
      min: null, max: null, confidence: null, status: null, reason: 'NON_MILLESIME', source: null,
    });
  });

  it('correction manuelle 2030-2035 sur le Chateauneuf : elle prime, confiance "saisie"', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhone', year: 2016, quality: 'GRAND' }] });
    expect(estimateApogee(wine({ apogeeMin: 2030, apogeeMax: 2035, apogeeSource: 'MANUEL' }), r, YEAR)).toEqual({
      min: 2030, max: 2035, confidence: 'SAISIE', status: 'TROP_JEUNE', reason: null, source: 'MANUEL',
    });
  });
});

describe('estimateApogee — priorites et absences', () => {
  it('l\'ajustement par couleur passe avant l\'ajustement toutes couleurs', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'cdp', color: null, min: 1, max: 2 }, { appellationId: 'cdp', color: 'ROUGE', min: 10, max: 30 }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2026, max: 2046 });
  });

  it('le rose passe avant l\'ajustement toutes couleurs', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'cdp', color: null, min: 10, max: 30 }] });
    expect(estimateApogee(wine({ color: 'ROSE' }), r, YEAR)).toMatchObject({ min: 2017, max: 2019 });
  });

  it('l\'ajustement toutes couleurs passe avant la garde du referentiel', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'cdp', color: null, min: 10, max: 30 }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2026, max: 2046 });
  });

  it('un ajustement d\'une autre appellation ne s\'applique pas', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'autre', color: null, min: 10, max: 30 }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2024, max: 2036 });
  });

  it('appellation non reconnue : aucune estimation, meme pour un rose', () => {
    expect(estimateApogee(wine({ appellationId: null, color: 'ROSE' }), EMPTY_APOGEE_RULES, YEAR).reason).toBe('APPELLATION_INCONNUE');
  });

  it('appellation sans garde ni ajustement : aucune estimation', () => {
    expect(estimateApogee(wine({ referenceGuardMin: null, referenceGuardMax: null }), EMPTY_APOGEE_RULES, YEAR).reason).toBe('GARDE_INCONNUE');
  });

  it('une appellation sans region n\'est jamais qualifiee : facteur 1, confiance faible', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhone', year: 2016, quality: 'GRAND' }] });
    expect(estimateApogee(wine({ region: null }), r, YEAR)).toMatchObject({ min: 2024, max: 2036, confidence: 'FAIBLE' });
  });

  it('la qualite d\'une autre region ou d\'une autre annee ne s\'applique pas', () => {
    const r = rules({ vintageQualities: [{ region: 'Bordeaux', year: 2016, quality: 'GRAND' }, { region: 'Rhone', year: 2015, quality: 'GRAND' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2024, max: 2036, confidence: 'FAIBLE' });
  });

  it('une correction manuelle vaut aussi pour un vin non millesime ou d\'appellation inconnue', () => {
    const manual = { apogeeMin: 2027, apogeeMax: 2029, apogeeSource: 'MANUEL' };
    expect(estimateApogee(wine({ vintage: null, ...manual }), EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2027, max: 2029, confidence: 'SAISIE', source: 'MANUEL' });
    expect(estimateApogee(wine({ appellationId: null, ...manual }), EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2027, confidence: 'SAISIE' });
  });

  it('ignore une correction incomplète et revient à la règle', () => {
    expect(estimateApogee(wine({ apogeeMin: 2030, apogeeMax: null, apogeeSource: 'MANUEL' }), EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2024, source: 'REGLE' });
  });
});

describe('apogeeStatus', () => {
  it.each([
    [2027, 2034, 2026, 'TROP_JEUNE'],
    [2024, 2036, 2024, 'A_BOIRE'],
    [2024, 2036, 2035, 'A_BOIRE'],
    [2024, 2036, 2036, 'A_BOIRE_VITE'],
    [2026, 2026, 2026, 'A_BOIRE_VITE'],
    [2020, 2025, 2026, 'PASSEE'],
  ])('min %i, max %i, année %i → %s', (min, max, year, expected) => {
    expect(apogeeStatus(min, max, year)).toBe(expected);
  });
});

describe('à boire en priorité', () => {
  const at = (max: number | null) => ({ min: max == null ? null : 2000, max, confidence: null, status: null, reason: null, source: null });

  it('retient une fin d’apogée passée, de l’année en cours ou de l’an prochain', () => {
    expect(isDrinkSoon(at(2020), YEAR)).toBe(true);
    expect(isDrinkSoon(at(2026), YEAR)).toBe(true);
    expect(isDrinkSoon(at(2027), YEAR)).toBe(true);
  });

  it('écarte une fin d’apogée dans deux ans ou plus', () => {
    expect(isDrinkSoon(at(2028), YEAR)).toBe(false);
  });

  it('écarte un vin sans estimation', () => {
    expect(isDrinkSoon(at(null), YEAR)).toBe(false);
  });

  it('prend en compte la correction manuelle', () => {
    const manual = estimateApogee(wine({ apogeeMin: 2020, apogeeMax: 2027, apogeeSource: 'MANUEL' }), EMPTY_APOGEE_RULES, YEAR);
    expect(isDrinkSoon(manual, YEAR)).toBe(true);
  });

  it('range la fin d’apogée la plus proche en premier, sans changer l’ordre des ex æquo', () => {
    const items = [{ id: 'b', apogee: at(2027) }, { id: 'a', apogee: at(2020) }, { id: 'c', apogee: at(2027) }];
    expect(sortByApogeeEnd(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
