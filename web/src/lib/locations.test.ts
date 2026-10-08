import type { Location, Zone } from './api-client';
import { distinctParts, inputLabel, lastUsedInput, toLocationInput } from './locations';

const locations: Location[] = [
  { id: 'l1', zoneId: 'z1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3', lastUsed: true },
  { id: 'l2', zoneId: 'z1', zone: 'Cave 2', casier: 'A', position: null, label: 'Cave 2 / A', lastUsed: false },
];
const zones: Zone[] = [
  { id: 'z1', name: 'Cave 2', indication: null, hasPhoto: false, sortOrder: 0 },
  { id: 'z2', name: 'Garage', indication: 'Au fond', hasPhoto: true, sortOrder: 1 },
];

describe('toLocationInput', () => {
  it('rend null quand rien n’est choisi ni saisi (« Sans emplacement »)', () => {
    expect(toLocationInput({ zoneId: null, casier: '  ', position: null })).toBeNull();
  });
  it('nettoie casier et position, remplace les vides par null, garde la zone choisie', () => {
    expect(toLocationInput({ zoneId: 'z1', casier: '', position: ' 3 ' })).toEqual({ zoneId: 'z1', casier: null, position: '3' });
    expect(toLocationInput({ zoneId: 'z2', casier: null, position: null })).toEqual({ zoneId: 'z2', casier: null, position: null });
  });
});

describe('inputLabel', () => {
  it('« zone / casier / position » avec le nom de la zone choisie, « Sans emplacement » sinon', () => {
    expect(inputLabel({ zoneId: 'z2', casier: 'B', position: null }, zones)).toBe('Garage / B');
    expect(inputLabel({ zoneId: null, casier: null, position: '4' }, zones)).toBe('4');
    expect(inputLabel({ zoneId: null, casier: ' ', position: null }, zones)).toBe('Sans emplacement');
  });
});

describe('distinctParts', () => {
  it('liste sans doublon les casiers et positions déjà saisis', () => {
    expect(distinctParts(locations)).toEqual({ casier: ['A', 'B'], position: ['3'] });
  });
});

describe('lastUsedInput', () => {
  it('l’emplacement marqué lastUsed, ramené à sa zone (zoneId), casier et position', () => {
    expect(lastUsedInput(locations)).toEqual({ zoneId: 'z1', casier: 'B', position: '3' });
    expect(lastUsedInput([{ ...locations[1] }])).toBeNull();
    expect(lastUsedInput(undefined)).toBeNull();
  });
});
