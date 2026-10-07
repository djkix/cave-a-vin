import type { Location } from './api-client';
import { distinctParts, toLocationInput } from './locations';

const locations: Location[] = [
  { id: 'l1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3', lastUsed: true },
  { id: 'l2', zone: 'Cave 2', casier: 'A', position: null, label: 'Cave 2 / A', lastUsed: false },
];

describe('toLocationInput', () => {
  it('rend null quand les trois champs sont vides (« Sans emplacement »)', () => {
    expect(toLocationInput({ zone: '  ', casier: '', position: null })).toBeNull();
  });
  it('nettoie les champs et remplace les vides par null', () => {
    expect(toLocationInput({ zone: ' Cave 2 ', casier: '', position: '3' })).toEqual({ zone: 'Cave 2', casier: null, position: '3' });
  });
});

describe('distinctParts', () => {
  it('liste sans doublon les valeurs de chaque champ', () => {
    expect(distinctParts(locations)).toEqual({ zone: ['Cave 2'], casier: ['A', 'B'], position: ['3'] });
  });
});
