import { producerKeyOf } from './producer-key';

describe('producerKeyOf', () => {
  it('donne la même clé quelle que soit la casse, les accents ou la ponctuation', () => {
    expect(producerKeyOf('Domaine Tempier')).toBe('domaine tempier');
    expect(producerKeyOf('DOMAINE TEMPIER')).toBe('domaine tempier');
    expect(producerKeyOf('  Château  de Beaucastel ')).toBe(producerKeyOf('chateau-de-beaucastel'));
  });

  it('rend une clé vide pour un nom sans lettre ni chiffre', () => {
    expect(producerKeyOf(' — ')).toBe('');
  });
});

