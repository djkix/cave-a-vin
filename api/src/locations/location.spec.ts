import { BadRequestException } from '@nestjs/common';
import { formatPlaces, labelOf, normalizeLocation, placesOf } from './location';

describe('normalizeLocation', () => {
  it('nettoie les champs, vide = absent, clé en minuscules jointe par |', () => {
    expect(normalizeLocation({ zone: '  Cave 2 ', casier: 'B', position: '' })).toEqual({ zone: 'Cave 2', casier: 'B', position: null, labelKey: 'cave 2|b|' });
    expect(normalizeLocation({ casier: ' b ' })).toEqual({ zone: null, casier: 'b', position: null, labelKey: '|b|' });
    expect(normalizeLocation({ zone: null, casier: undefined, position: '3' }).labelKey).toBe('||3');
  });

  it('même emplacement quelle que soit la casse ou les espaces', () => {
    expect(normalizeLocation({ zone: 'CAVE 2', casier: ' B' }).labelKey).toBe(normalizeLocation({ zone: 'cave 2 ', casier: 'b' }).labelKey);
  });

  it('refuse un emplacement vide', () => {
    expect(() => normalizeLocation({})).toThrow(new BadRequestException('Indiquez au moins une zone, un casier ou une position'));
    expect(() => normalizeLocation({ zone: '   ', casier: '', position: null })).toThrow(BadRequestException);
  });

  it('refuse un champ de plus de 40 caractères (une fois nettoyé)', () => {
    expect(normalizeLocation({ zone: ` ${'a'.repeat(40)} ` }).zone).toHaveLength(40);
    expect(() => normalizeLocation({ position: 'a'.repeat(41) })).toThrow(new BadRequestException('40 caractères au plus par champ d\'emplacement'));
  });
});

describe('labelOf', () => {
  it('« zone / casier / position » sans les parties absentes', () => {
    expect(labelOf({ zone: 'Cave 2', casier: 'B', position: '3' })).toBe('Cave 2 / B / 3');
    expect(labelOf({ zone: null, casier: 'B', position: null })).toBe('B');
    expect(labelOf({ zone: 'Cellier', casier: null, position: '12' })).toBe('Cellier / 12');
  });
});

describe('placesOf', () => {
  const loc = (id: string, zone: string) => ({ id, zone, casier: null, position: null });

  it('emplacements par libellé puis « Sans emplacement » (total − stocks positifs), quantités > 0 seulement', () => {
    expect(
      placesOf([
        { location: loc('l2', 'Placard'), quantity: 2 },
        { location: null, quantity: 3 },
        { location: loc('l1', 'Cave'), quantity: 4 },
        { location: loc('l3', 'Vide'), quantity: 0 },
      ]),
    ).toEqual([
      { id: 'l1', label: 'Cave', quantity: 4 },
      { id: 'l2', label: 'Placard', quantity: 2 },
      { id: null, label: 'Sans emplacement', quantity: 3 },
    ]);
  });

  it('« Sans emplacement » jamais négatif ni nul à l’affichage', () => {
    expect(placesOf([{ location: loc('l1', 'Cave'), quantity: 2 }, { location: null, quantity: -2 }])).toEqual([{ id: 'l1', label: 'Cave', quantity: 2 }]);
    expect(placesOf([{ location: loc('l1', 'Cave'), quantity: 2 }])).toEqual([{ id: 'l1', label: 'Cave', quantity: 2 }]);
  });
});

describe('formatPlaces', () => {
  it('« Cave 2 / B / 3 × 4 ; Sans emplacement × 2 »', () => {
    expect(formatPlaces([{ id: 'l', label: 'Cave 2 / B / 3', quantity: 4 }, { id: null, label: 'Sans emplacement', quantity: 2 }])).toBe(
      'Cave 2 / B / 3 × 4 ; Sans emplacement × 2',
    );
    expect(formatPlaces([])).toBe('');
  });
});
