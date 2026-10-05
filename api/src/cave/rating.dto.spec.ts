import { ratingSchema } from './rating.dto';

const messages = (input: unknown) => {
  const r = ratingSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('ratingSchema', () => {
  it('accepte 0, 16,5 et 20', () => {
    for (const rating of [0, 16.5, 20]) expect(ratingSchema.parse({ rating })).toEqual({ rating });
  });

  it('refuse hors bornes, en français', () => {
    expect(messages({ rating: -1 })).toEqual(['La note doit être comprise entre 0 et 20']);
    expect(messages({ rating: 20.5 })).toEqual(['La note doit être comprise entre 0 et 20']);
    expect(messages({})).toEqual(['La note doit être comprise entre 0 et 20']);
    expect(messages({ rating: 'seize' })).toEqual(['La note doit être comprise entre 0 et 20']);
  });

  it('refuse ce qui n’est pas un demi-point', () => {
    expect(messages({ rating: 16.3 })).toEqual(['La note se donne par demi-point']);
  });
});
