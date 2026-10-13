import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { DrinkSoonCard } from '../components/DrinkSoonCard';
import { viewerMe } from '../test-fixtures';
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
    { id: 'z1', name: 'Garage', indication: 'Au fond, derrière l’escalier', hasPhoto: true, sortOrder: 0, marker: null },
    { id: 'z2', name: 'Cave 2', indication: null, hasPhoto: false, sortOrder: 1, marker: null },
  ]);
  mount(<ABoirePage />);
  const garage = await screen.findByRole('region', { name: 'Garage' });
  expect(await within(garage).findByText('Au fond, derrière l’escalier')).toBeInTheDocument();
  expect(within(garage).getByRole('img', { name: 'Photo de la zone Garage' })).toHaveAttribute('src', '/api/caves/zones/z1/photo');
  const cave = screen.getByRole('region', { name: 'Cave 2 / B' });
  expect(within(cave).queryByRole('img')).not.toBeInTheDocument();
});

describe('plan de la cave', () => {
  const plan = { width: 1200, height: 800, updatedAt: '2026-10-13T10:00:00.000Z' };
  const markers = [{ zoneId: 'z1', name: 'Garage', number: 1, x: 0.2, y: 0.3 }, { zoneId: 'z3', name: 'Cellier', number: 2, x: 0.8, y: 0.8 }];

  beforeEach(() => {
    vi.spyOn(api, 'getCave').mockResolvedValue([
      row('Tempier', 2026, [{ id: 'g', label: 'Garage', quantity: 1, zoneId: 'z1' }, { id: 'c', label: 'Cave 2 / B', quantity: 1, zoneId: 'z2' }]),
    ]);
    vi.spyOn(api, 'getZones').mockResolvedValue([
      { id: 'z1', name: 'Garage', indication: null, hasPhoto: false, sortOrder: 0, marker: { x: 0.2, y: 0.3 } },
      { id: 'z2', name: 'Cave 2', indication: null, hasPhoto: false, sortOrder: 1, marker: null },
    ]);
    vi.spyOn(api, 'getPlan').mockResolvedValue({ plan, markers });
  });

  it('un petit plan sous l’en-tête d’une zone placée, avec son seul repère ; touché, il s’agrandit avec tous les repères', async () => {
    mount(<ABoirePage />);
    const garage = await screen.findByRole('region', { name: 'Garage' });
    const mini = await within(garage).findByRole('button', { name: 'Agrandir le plan' });
    expect(within(mini).getByRole('img', { name: 'Zone 1 : Garage' })).toHaveAttribute('aria-current', 'true');
    expect(within(mini).queryByRole('img', { name: 'Zone 2 : Cellier' })).not.toBeInTheDocument();
    expect((within(mini).getByRole('img', { name: 'Plan de la cave' }).parentElement as HTMLElement).style.maxWidth).toBe('160px');
    // Zone sans repère : pas de plan.
    expect(within(screen.getByRole('region', { name: 'Cave 2 / B' })).queryByRole('img', { name: 'Plan de la cave' })).not.toBeInTheDocument();

    await userEvent.click(mini);
    expect(within(garage).getByRole('img', { name: 'Zone 2 : Cellier' })).toBeInTheDocument();
    expect(within(garage).getByRole('img', { name: 'Zone 1 : Garage' })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(within(garage).getByRole('button', { name: 'Réduire le plan' }));
    expect(within(garage).getByRole('button', { name: 'Agrandir le plan' })).toBeInTheDocument();
  });

  it('membre : le même petit plan, sans aucune commande de placement', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
    mount(<ABoirePage />);
    const garage = await screen.findByRole('region', { name: 'Garage' });
    expect(await within(garage).findByRole('button', { name: 'Agrandir le plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Zone \d/ })).not.toBeInTheDocument();
  });
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
