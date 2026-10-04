import { trigramSimilarity } from './trigram';

describe('trigramSimilarity', () => {
  it('vaut 1 pour deux textes identiques', () => {
    expect(trigramSimilarity('tempier tourtine', 'tempier tourtine')).toBe(1);
  });

  it('vaut 0 quand un côté est vide', () => {
    expect(trigramSimilarity('', 'tempier')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });

  it('reprend la définition de pg_trgm : similarity(\'word\', \'two words\') = 0.363636…', () => {
    // Valeur documentée de PostgreSQL : 4 trigrammes communs sur 11 distincts.
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(4 / 11, 6);
  });

  it('est symétrique', () => {
    expect(trigramSimilarity('gauby vieilles vignes', 'gauby')).toBe(trigramSimilarity('gauby', 'gauby vieilles vignes'));
  });
});
