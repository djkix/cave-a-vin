import { createHash } from 'node:crypto';
import { producerKeyOf } from './producer-key';
import { producerJobId } from './producer.queue';

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

describe('producerJobId', () => {
  it('identifie le travail par le sha1 hexadécimal de la clé (la clé contient des espaces)', () => {
    const sha1 = createHash('sha1').update('domaine tempier').digest('hex');
    expect(producerJobId('domaine tempier')).toBe(`producer-${sha1}`);
    expect(producerJobId('domaine tempier')).toMatch(/^producer-[0-9a-f]{40}$/);
  });
});
