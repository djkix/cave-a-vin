import { isTransientVisionFailure } from '../queue/transient-failure';
import { PairingInvalidOutputError, parsePairingOutput } from './pairing-output';

describe('parsePairingOutput', () => {
  it('rend les plats rognés, sans doublons (accents et majuscules ignorés)', () => {
    expect(parsePairingOutput({ plats: [' Agneau de sept heures ', 'Daube  provençale', 'agneau de sept HEURES', 'Daube provencale'] }))
      .toEqual(['Agneau de sept heures', 'Daube provençale']);
  });

  it.each([
    ['sans champ plats', { dishes: ['x'] }],
    ['liste vide', { plats: [] }],
    ['plus de 8 plats', { plats: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['plat vide', { plats: ['agneau', '  '] }],
    ['plat trop long', { plats: ['x'.repeat(61)] }],
    ['plat non textuel', { plats: ['agneau', 3] }],
    ['réponse non objet', 'agneau'],
  ])('refuse une réponse inexploitable : %s', (_label, raw) => {
    expect(() => parsePairingOutput(raw)).toThrow(PairingInvalidOutputError);
  });

  it('classe une réponse inexploitable en échec définitif', () => {
    let error: unknown;
    try { parsePairingOutput({ plats: [] }); } catch (e) { error = e; }
    expect(isTransientVisionFailure(error)).toBe(false);
  });
});
