import { isTransientVisionFailure } from '../queue/transient-failure';
import { ProducerInvalidOutputError, parseProducerOutput } from './producer-output';

const text = (n: number) => 'a'.repeat(n);

describe('parseProducerOutput', () => {
  it('rend le descriptif rogné d’un domaine connu', () => {
    const description = `  ${'Domaine familial du Castellet, au cœur de Bandol. '.repeat(2).trim()}  `;
    expect(parseProducerOutput({ connu: true, description })).toEqual({ known: true, description: description.trim() });
  });

  it('rend « inconnu » pour un domaine peu documenté', () => {
    expect(parseProducerOutput({ connu: false })).toEqual({ known: false });
    expect(parseProducerOutput({ connu: false, description: 'ignoré' })).toEqual({ known: false });
  });

  it('accepte les bornes : 40 et 1200 caractères', () => {
    expect(parseProducerOutput({ connu: true, description: text(40) })).toEqual({ known: true, description: text(40) });
    expect(parseProducerOutput({ connu: true, description: text(1200) })).toEqual({ known: true, description: text(1200) });
  });

  it.each([
    ['trop court', { connu: true, description: text(39) }],
    ['trop long', { connu: true, description: text(1201) }],
    ['vide', { connu: true, description: '   ' }],
    ['sans descriptif', { connu: true }],
    ['descriptif non textuel', { connu: true, description: 42 }],
    ['sans champ connu', { description: text(100) }],
    ['champ connu non booléen', { connu: 'oui', description: text(100) }],
    ['réponse non objet', 'Domaine Tempier'],
    ['réponse nulle', null],
  ])('refuse une réponse inexploitable : %s', (_label, raw) => {
    expect(() => parseProducerOutput(raw)).toThrow(ProducerInvalidOutputError);
    expect(() => parseProducerOutput(raw)).toThrow(/^Sortie du modèle invalide/);
  });

  it('classe une réponse inexploitable en échec définitif', () => {
    let error: unknown;
    try { parseProducerOutput({ connu: true, description: 'court' }); } catch (e) { error = e; }
    expect(isTransientVisionFailure(error)).toBe(false);
  });
});
