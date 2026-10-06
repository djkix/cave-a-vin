import { PRODUCER_DESCRIPTION_LENGTH, producerDescriptionSchema } from './producer-description.dto';

const MESSAGE = 'Le descriptif doit faire entre 1 et 2000 caractères';

describe('producerDescriptionSchema', () => {
  it('rogne le texte', () => {
    expect(producerDescriptionSchema.parse({ description: '  Un domaine du Castellet.  ' })).toEqual({ description: 'Un domaine du Castellet.' });
  });

  it('accepte 1 et 2000 caractères', () => {
    expect(producerDescriptionSchema.safeParse({ description: 'x' }).success).toBe(true);
    expect(producerDescriptionSchema.safeParse({ description: 'x'.repeat(2000) }).success).toBe(true);
  });

  it.each([
    ['vide', { description: '' }],
    ['blanc', { description: '   ' }],
    ['trop long', { description: 'x'.repeat(2001) }],
    ['non textuel', { description: 12 }],
    ['absent', {}],
  ])('refuse un descriptif %s avec un message en français', (_label, body) => {
    const r = producerDescriptionSchema.safeParse(body);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message)).toEqual([MESSAGE]);
  });

  it('expose la limite de 2000 caractères', () => {
    expect(PRODUCER_DESCRIPTION_LENGTH).toBe(2000);
  });
});
