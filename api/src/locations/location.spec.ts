import { BadRequestException } from '@nestjs/common';
import { formatPlaces, labelOf, locationInputSchema, normalizeLocation, partsOf, placesOf } from './location';

describe('normalizeLocation', () => {
  const ZONE = '7d9f2a52-3c1e-4f0e-9a3b-2f5e8c1d4a60';

  it('nettoie casier et position, vide = absent ; la zone est un identifiant de zone de la cave', () => {
    expect(normalizeLocation({ zoneId: ZONE, casier: ' B ', position: '' })).toEqual({ zoneId: ZONE, zoneName: null, casier: 'B', position: null });
    expect(normalizeLocation({ casier: ' b ' })).toEqual({ zoneId: null, zoneName: null, casier: 'b', position: null });
    expect(normalizeLocation({ zoneId: null, casier: undefined, position: '3' })).toEqual({ zoneId: null, zoneName: null, casier: null, position: '3' });
  });

  it('ancien client : `zone` en texte, nettoyé, est gardé comme nom de zone à retrouver ; un identifiant l’emporte', () => {
    expect(normalizeLocation({ zone: '  Cave 2 ', casier: 'B' })).toEqual({ zoneId: null, zoneName: 'Cave 2', casier: 'B', position: null });
    expect(normalizeLocation({ zoneId: ZONE, zone: 'Cave 2' })).toEqual({ zoneId: ZONE, zoneName: null, casier: null, position: null });
  });

  it('refuse un emplacement vide', () => {
    expect(() => normalizeLocation({})).toThrow(new BadRequestException('Indiquez au moins une zone, un casier ou une position'));
    expect(() => normalizeLocation({ zone: '   ', casier: '', position: null })).toThrow(BadRequestException);
    expect(() => normalizeLocation({ zoneId: null, casier: ' ' })).toThrow(BadRequestException);
  });

  it('refuse un champ de plus de 40 caractères (une fois nettoyé)', () => {
    expect(normalizeLocation({ zone: ` ${'a'.repeat(40)} ` }).zoneName).toHaveLength(40);
    expect(() => normalizeLocation({ position: 'a'.repeat(41) })).toThrow(new BadRequestException('40 caractères au plus par champ d\'emplacement'));
    expect(() => normalizeLocation({ zone: 'a'.repeat(41) })).toThrow(new BadRequestException('40 caractères au plus par champ d\'emplacement'));
  });
});

describe('locationInputSchema', () => {
  it('zoneId : un UUID ou null', () => {
    expect(locationInputSchema.safeParse({ zoneId: 'pas-un-uuid' }).success).toBe(false);
    expect(locationInputSchema.safeParse({ zoneId: null, casier: 'B' }).success).toBe(true);
    expect(locationInputSchema.safeParse({ zone: 'Cave 1' }).success).toBe(true);
  });
});

describe('partsOf', () => {
  it('le nom de la zone vient de la relation (il suit les renommages)', () => {
    expect(partsOf({ id: 'l1', zoneId: 'z1', zone: { name: 'Cellier' }, casier: 'B', position: null })).toEqual({
      id: 'l1', zoneId: 'z1', zone: 'Cellier', casier: 'B', position: null,
    });
    expect(partsOf({ id: 'l2', zoneId: null, zone: null, casier: null, position: '4' })).toEqual({ id: 'l2', zoneId: null, zone: null, casier: null, position: '4' });
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
  const loc = (id: string, zone: string) => ({ id, zoneId: `z-${zone}`, zone, casier: null, position: null });

  it('emplacements par libellé puis « Sans emplacement » (total − stocks positifs), quantités > 0 seulement', () => {
    expect(
      placesOf([
        { location: loc('l2', 'Placard'), quantity: 2 },
        { location: null, quantity: 3 },
        { location: loc('l1', 'Cave'), quantity: 4 },
        { location: loc('l3', 'Vide'), quantity: 0 },
      ]),
    ).toEqual([
      { id: 'l1', label: 'Cave', quantity: 4, zoneId: 'z-Cave' },
      { id: 'l2', label: 'Placard', quantity: 2, zoneId: 'z-Placard' },
      { id: null, label: 'Sans emplacement', quantity: 3, zoneId: null },
    ]);
  });

  it('« Sans emplacement » jamais négatif ni nul à l’affichage', () => {
    expect(placesOf([{ location: loc('l1', 'Cave'), quantity: 2 }, { location: null, quantity: -2 }])).toEqual([{ id: 'l1', label: 'Cave', quantity: 2, zoneId: 'z-Cave' }]);
    expect(placesOf([{ location: loc('l1', 'Cave'), quantity: 2 }])).toEqual([{ id: 'l1', label: 'Cave', quantity: 2, zoneId: 'z-Cave' }]);
  });
});

describe('formatPlaces', () => {
  it('« Cave 2 / B / 3 × 4 ; Sans emplacement × 2 »', () => {
    expect(formatPlaces([{ id: 'l', label: 'Cave 2 / B / 3', quantity: 4, zoneId: 'z' }, { id: null, label: 'Sans emplacement', quantity: 2, zoneId: null }])).toBe(
      'Cave 2 / B / 3 × 4 ; Sans emplacement × 2',
    );
    expect(formatPlaces([])).toBe('');
  });
});
