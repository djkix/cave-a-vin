import { guardOverrideSchema, manualApogeeSchema, vintageQualitySchema } from './dto';

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message));

describe('manualApogeeSchema', () => {
  it('accepte une fourchette valide', () => {
    expect(manualApogeeSchema.safeParse({ min: 2027, max: 2034 }).success).toBe(true);
  });
  it('accepte une fourchette d’une seule année', () => {
    expect(manualApogeeSchema.safeParse({ min: 2030, max: 2030 }).success).toBe(true);
  });
  it('refuse une fin avant le début, en français', () => {
    expect(messages(manualApogeeSchema.safeParse({ min: 2034, max: 2027 }))).toEqual(['L’année de début doit précéder ou égaler l’année de fin']);
  });
  it.each([[1899, 2000], [2000, 2201], [2027.5, 2030]])('refuse %p-%p', (min, max) => {
    expect(manualApogeeSchema.safeParse({ min, max }).success).toBe(false);
  });
  it('refuse des champs absents avec des messages français', () => {
    expect(messages(manualApogeeSchema.safeParse({}))).toEqual(['Année de début requise', 'Année de fin requise']);
  });
});

describe('vintageQualitySchema', () => {
  it('accepte un millésime qualifié', () => {
    expect(vintageQualitySchema.safeParse({ region: 'Rhône', year: 2016, quality: 'GRAND' }).success).toBe(true);
  });
  it('refuse une année dans plus d’un an', () => {
    expect(messages(vintageQualitySchema.safeParse({ region: 'Rhône', year: new Date().getFullYear() + 2, quality: 'GRAND' }))).toEqual(['Année dans le futur']);
  });
  it('refuse une qualité inconnue en français', () => {
    expect(messages(vintageQualitySchema.safeParse({ region: 'Rhône', year: 2016, quality: 'EXCEPTIONNEL' }))).toEqual(['Qualité inconnue']);
  });
});

describe('guardOverrideSchema', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('accepte un ajustement toutes couleurs et un ajustement par couleur', () => {
    expect(guardOverrideSchema.safeParse({ appellationId: id, min: 4, max: 12 }).success).toBe(true);
    expect(guardOverrideSchema.safeParse({ appellationId: id, color: 'ROSE', min: 1, max: 3 }).success).toBe(true);
  });
  it('refuse une garde minimale supérieure à la maximale', () => {
    expect(messages(guardOverrideSchema.safeParse({ appellationId: id, min: 9, max: 3 }))).toEqual(['La garde minimale doit être inférieure ou égale à la maximale']);
  });
  it.each([[-1, 3], [1, 101]])('refuse la garde %p-%p', (min, max) => {
    expect(guardOverrideSchema.safeParse({ appellationId: id, min, max }).success).toBe(false);
  });
  it('refuse une couleur inconnue', () => {
    expect(guardOverrideSchema.safeParse({ appellationId: id, color: 'ORANGE', min: 1, max: 3 }).success).toBe(false);
  });
});
