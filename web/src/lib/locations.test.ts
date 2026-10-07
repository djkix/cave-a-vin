import type { Location, MovementWithWine } from './api-client';
import { distinctParts, lastInLocation, toLocationInput } from './locations';

const wine = { id: 'w1', producer: 'Domaine Tempier', cuvee: null, appellationRaw: 'Bandol', vintage: 2019 };
const row = (over: Partial<MovementWithWine>): MovementWithWine => ({
  id: 'm', delta: 1, type: 'IN', occurredAt: '2026-10-01T10:00:00Z', note: null, reversesId: null, locationId: null, locationLabel: null, wine, ...over,
});
const locations: Location[] = [
  { id: 'l1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3' },
  { id: 'l2', zone: 'Cave 2', casier: 'A', position: null, label: 'Cave 2 / A' },
];

describe('toLocationInput', () => {
  it('rend null quand les trois champs sont vides (« Sans emplacement »)', () => {
    expect(toLocationInput({ zone: '  ', casier: '', position: null })).toBeNull();
  });
  it('nettoie les champs et remplace les vides par null', () => {
    expect(toLocationInput({ zone: ' Cave 2 ', casier: '', position: '3' })).toEqual({ zone: 'Cave 2', casier: null, position: '3' });
  });
});

describe('lastInLocation', () => {
  it('prend la dernière entrée rangée, non annulée', () => {
    const rows = [
      row({ id: 'r', type: 'ADJUST', delta: -1, reversesId: 'm2' }),
      row({ id: 'm2', locationId: 'l2' }),
      row({ id: 'o', type: 'OUT', delta: -1, locationId: 'l2' }),
      row({ id: 'm1', locationId: 'l1' }),
    ];
    expect(lastInLocation(rows, locations)).toEqual({ zone: 'Cave 2', casier: 'B', position: '3' });
  });
  it('ignore les entrées sans emplacement et les déplacements', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', type: 'MOVE', locationId: 'l2' }), row({ id: 'c', locationId: 'l2' })];
    expect(lastInLocation(rows, locations)).toEqual({ zone: 'Cave 2', casier: 'A', position: null });
  });
  it('rend null sans données ou sans entrée rangée', () => {
    expect(lastInLocation(undefined, locations)).toBeNull();
    expect(lastInLocation([row({})], locations)).toBeNull();
  });
});

describe('distinctParts', () => {
  it('liste sans doublon les valeurs de chaque champ', () => {
    expect(distinctParts(locations)).toEqual({ zone: ['Cave 2'], casier: ['A', 'B'], position: ['3'] });
  });
});
