import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { Location, LocationParts } from '../lib/api-client';
import { EntryLocationBlock } from './LocationFields';

const locations: Location[] = [
  { id: 'l1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3', lastUsed: false },
  { id: 'l2', zone: 'Garage', casier: null, position: null, label: 'Garage', lastUsed: false },
];

function Harness({ initial }: { initial: LocationParts }) {
  const [v, setV] = useState(initial);
  return <EntryLocationBlock value={v} onChange={setV} locations={locations} />;
}

it('est replié par défaut et montre l’emplacement pré-rempli dans son titre', () => {
  const { container } = render(<Harness initial={{ zone: 'Cave 2', casier: 'B', position: '3' }} />);
  const details = container.querySelector('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(screen.getByText('Emplacement')).toBeInTheDocument();
  expect(screen.getByText('Cave 2 / B / 3')).toBeInTheDocument();
  expect(screen.getByLabelText('Zone')).toHaveValue('Cave 2');
  expect(screen.getByLabelText('Casier')).toHaveValue('B');
  expect(screen.getByLabelText('Position')).toHaveValue('3');
});

it('annonce « Sans emplacement » quand rien n’est saisi', () => {
  render(<Harness initial={{ zone: null, casier: null, position: null }} />);
  expect(screen.getByText('Sans emplacement')).toBeInTheDocument();
});

it('propose les emplacements existants dans une datalist par champ', async () => {
  const { container } = render(<Harness initial={{ zone: null, casier: null, position: null }} />);
  const zone = screen.getByLabelText('Zone');
  const list = container.querySelector(`datalist#${CSS.escape(zone.getAttribute('list')!)}`)!;
  expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['Cave 2', 'Garage']);
  const casier = container.querySelector(`datalist#${CSS.escape(screen.getByLabelText('Casier').getAttribute('list')!)}`)!;
  expect([...casier.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['B']);
  expect(zone).toHaveAttribute('maxLength', '40');
  await userEvent.type(zone, 'Cellier');
  expect(screen.getByText('Cellier')).toBeInTheDocument();
});
