import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { DrinkSoonCard } from '../components/DrinkSoonCard';
import { ABoirePage } from './ABoirePage';

afterEach(() => vi.restoreAllMocks());

const row = (id: string, max: number, places: api.Place[]): api.CaveRow => ({
  id, producer: `Domaine ${id}`, cuvee: null, appellationRaw: 'Bandol', vintage: 2015, color: 'ROUGE', formatCl: 75,
  referencePhotoId: null, quantity: places.reduce((s, p) => s + p.quantity, 0),
  apogee: { min: 2018, max, confidence: 'MOYENNE', status: 'A_BOIRE_VITE', reason: null, source: 'REGLE' }, rating: null, places,
});

function mount(ui: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

it('la page liste les vins à boire par emplacement, avec la quantité de chaque endroit', async () => {
  const get = vi.spyOn(api, 'getCave').mockResolvedValue([
    row('Tempier', 2026, [{ id: 'g', label: 'Garage', quantity: 1 }, { id: null, label: 'Sans emplacement', quantity: 2 }]),
  ]);
  mount(<ABoirePage />);
  const garage = await screen.findByRole('region', { name: 'Garage' });
  expect(within(garage).getByRole('link', { name: /Domaine Tempier 2015/ })).toHaveAttribute('href', '/cave/Tempier');
  expect(within(garage).getByText('1')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Sans emplacement' })).getByText('2')).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith({ drinkSoon: true });
});

it('chaque en-tête d’emplacement montre l’indication et la vignette de sa zone, s’il y en a', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([
    row('Tempier', 2026, [{ id: 'g', label: 'Garage', quantity: 1, zoneId: 'z1' }, { id: 'c', label: 'Cave 2 / B', quantity: 1, zoneId: 'z2' }]),
  ]);
  vi.spyOn(api, 'getZones').mockResolvedValue([
    { id: 'z1', name: 'Garage', indication: 'Au fond, derrière l’escalier', hasPhoto: true, sortOrder: 0 },
    { id: 'z2', name: 'Cave 2', indication: null, hasPhoto: false, sortOrder: 1 },
  ]);
  mount(<ABoirePage />);
  const garage = await screen.findByRole('region', { name: 'Garage' });
  expect(await within(garage).findByText('Au fond, derrière l’escalier')).toBeInTheDocument();
  expect(within(garage).getByRole('img', { name: 'Photo de la zone Garage' })).toHaveAttribute('src', '/api/caves/zones/z1/photo');
  const cave = screen.getByRole('region', { name: 'Cave 2 / B' });
  expect(within(cave).queryByRole('img')).not.toBeInTheDocument();
});

it('dit qu’il n’y a rien d’urgent quand la liste est vide', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount(<ABoirePage />);
  expect(await screen.findByText('Rien d’urgent à boire.')).toBeInTheDocument();
});

it('la carte de l’accueil montre les trois plus urgents, leur emplacement et « Tout voir »', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(
    ['a', 'b', 'c', 'd'].map((id, i) => row(id, 2026 + i, [{ id: 'g', label: 'Garage', quantity: 1 }])),
  );
  mount(<DrinkSoonCard />);
  expect(await screen.findByText('À boire prochainement')).toBeInTheDocument();
  expect(screen.getAllByText(/Garage/)).toHaveLength(3);
  expect(screen.queryByText(/Domaine d/)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Tout voir (4)' })).toHaveAttribute('href', '/a-boire');
});
