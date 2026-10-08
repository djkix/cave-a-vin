import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Location, LocationInput, Zone } from '../lib/api-client';
import { EntryLocationBlock, LocationFields } from './LocationFields';

const locations: Location[] = [
  { id: 'l1', zoneId: 'z2', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3', lastUsed: false },
  { id: 'l2', zoneId: 'z1', zone: 'Garage', casier: null, position: null, label: 'Garage', lastUsed: false },
];
// Ordre d'affichage choisi dans « Ma cave », pas l'ordre alphabétique.
const zones: Zone[] = [
  { id: 'z1', name: 'Garage', indication: 'Au fond, derrière l’escalier', hasPhoto: true, sortOrder: 0 },
  { id: 'z2', name: 'Cave 2', indication: null, hasPhoto: false, sortOrder: 1 },
];

function Harness({ initial, zoneList = zones, block = true }: { initial: LocationInput; zoneList?: Zone[] | null; block?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <MemoryRouter>
      {block
        ? <EntryLocationBlock value={v} onChange={setV} locations={locations} zones={zoneList ?? undefined} />
        : <LocationFields value={v} onChange={setV} locations={locations} zones={zoneList ?? undefined} />}
    </MemoryRouter>
  );
}

it('est replié par défaut et montre l’emplacement pré-rempli, zone par son nom, dans son titre', () => {
  const { container } = render(<Harness initial={{ zoneId: 'z2', casier: 'B', position: '3' }} />);
  const details = container.querySelector('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(screen.getByText('Emplacement')).toBeInTheDocument();
  expect(screen.getByText('Cave 2 / B / 3')).toBeInTheDocument();
  expect(screen.getByLabelText('Zone')).toHaveValue('z2');
  expect(screen.getByLabelText('Casier')).toHaveValue('B');
  expect(screen.getByLabelText('Position')).toHaveValue('3');
});

it('annonce « Sans emplacement » quand rien n’est choisi ni saisi', () => {
  render(<Harness initial={{ zoneId: null, casier: null, position: null }} />);
  expect(screen.getByText('Sans emplacement')).toBeInTheDocument();
});

it('la zone se choisit dans la liste des zones de la cave, dans leur ordre, plus « Sans zone »', async () => {
  render(<Harness initial={{ zoneId: null, casier: null, position: null }} block={false} />);
  const select = screen.getByLabelText('Zone');
  expect(select.tagName).toBe('SELECT');
  expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Sans zone', 'Garage', 'Cave 2']);
  expect(select).toHaveValue('');
  await userEvent.selectOptions(select, 'Cave 2');
  expect(select).toHaveValue('z2');
});

it('montre l’indication et la vignette de la zone choisie', async () => {
  render(<Harness initial={{ zoneId: null, casier: null, position: null }} block={false} />);
  expect(screen.queryByText('Au fond, derrière l’escalier')).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('Zone'), 'Garage');
  expect(screen.getByText('Au fond, derrière l’escalier')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Photo de la zone Garage' })).toHaveAttribute('src', '/api/caves/zones/z1/photo');
  // Zone sans indication ni photo : rien dessous.
  await userEvent.selectOptions(screen.getByLabelText('Zone'), 'Cave 2');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByText('Au fond, derrière l’escalier')).not.toBeInTheDocument();
});

it('casier et position restent libres, avec les valeurs déjà saisies en suggestion', async () => {
  const { container } = render(<Harness initial={{ zoneId: null, casier: null, position: null }} />);
  const casier = screen.getByLabelText('Casier');
  const list = container.querySelector(`datalist#${CSS.escape(casier.getAttribute('list')!)}`)!;
  expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['B']);
  const position = container.querySelector(`datalist#${CSS.escape(screen.getByLabelText('Position').getAttribute('list')!)}`)!;
  expect([...position.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['3']);
  expect(casier).toHaveAttribute('maxLength', '40');
  await userEvent.type(casier, 'Haut');
  expect(screen.getByText('Haut')).toBeInTheDocument();
});

it('sans aucune zone (liste lue) : lien « Créer une zone » vers « Ma cave », la saisie en cours sera perdue', () => {
  render(<Harness initial={{ zoneId: null, casier: null, position: null }} zoneList={[]} block={false} />);
  expect(screen.getByRole('link', { name: 'Créer une zone' })).toHaveAttribute('href', '/ma-cave');
  expect(screen.getByText(/la saisie en cours sera perdue/)).toBeInTheDocument();
  expect(within(screen.getByLabelText('Zone')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Sans zone']);
});

it('zones pas encore lues ou illisibles : choix grisé, zone pré-remplie affichée, pas de lien', () => {
  render(<Harness initial={{ zoneId: 'z2', casier: 'B', position: '3' }} zoneList={null} />);
  const select = screen.getByLabelText('Zone');
  expect(select).toBeDisabled();
  expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Cave 2']);
  // Le titre du bloc garde le libellé pré-rempli, nom de la zone compris.
  expect(screen.getByText('Cave 2 / B / 3')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Créer une zone' })).not.toBeInTheDocument();
});

it('avec des zones : pas de lien « Créer une zone »', () => {
  render(<Harness initial={{ zoneId: null, casier: null, position: null }} block={false} />);
  expect(screen.queryByRole('link', { name: 'Créer une zone' })).not.toBeInTheDocument();
});
