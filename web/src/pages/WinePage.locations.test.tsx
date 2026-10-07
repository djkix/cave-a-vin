import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { viewerMe } from '../test-fixtures';
import { WinePage } from './WinePage';

afterEach(() => vi.restoreAllMocks());

const detail: api.WineDetail = {
  wine: {
    id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 6,
    referencePhotoSource: null, referencePhotoSourceUrl: null, pairing: null, producerKey: null, producerProfile: null,
  },
  movements: [
    { id: 'mv2', delta: 2, type: 'MOVE', occurredAt: '2026-10-02T10:00:00Z', note: null, reversesId: null, locationId: 'l1', locationLabel: 'Cave 2 / B / 3' },
    { id: 'mv1', delta: -2, type: 'MOVE', occurredAt: '2026-10-02T10:00:00Z', note: null, reversesId: null, locationId: null, locationLabel: null },
    { id: 'm1', delta: 6, type: 'IN', occurredAt: '2026-09-21T10:00:00Z', note: null, reversesId: null, locationId: null, locationLabel: null },
  ],
  locations: [
    { id: 'l1', label: 'Cave 2 / B / 3', quantity: 2 },
    { id: 'l2', label: 'Garage', quantity: 1 },
    { id: null, label: 'Sans emplacement', quantity: 3 },
  ],
  exitDefault: 'l1',
  lastLocation: { zone: 'Cave 2', casier: 'B', position: '3' },
};

const cellar: api.Location[] = [
  { id: 'l1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3' },
  { id: 'l2', zone: 'Garage', casier: null, position: null, label: 'Garage' },
];

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cave/w1']}>
        <Routes>
          <Route path="/cave/:wineId" element={<WinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const section = () => within(screen.getByRole('region', { name: 'Emplacements' }));

it('liste chaque endroit et sa quantité, et les déplacements au journal du vin', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  await screen.findByRole('region', { name: 'Emplacements' });
  const items = section().getAllByRole('listitem').map((li) => li.textContent);
  expect(items).toEqual(['Cave 2 / B / 3 × 2', 'Garage × 1', 'Sans emplacement × 3']);
  expect(screen.getByText(/Déplacé · Cave 2 \/ B \/ 3/)).toBeInTheDocument();
  expect(screen.getByText(/Déplacé · Sans emplacement/)).toBeInTheDocument();
});

it('membre : voit les emplacements mais aucun bouton ni requête d’écriture', async () => {
  const me = vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const locations = vi.spyOn(api, 'getLocations').mockResolvedValue(cellar);
  const recent = vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  const move = vi.spyOn(api, 'moveWine');
  mount();
  await screen.findByRole('region', { name: 'Emplacements' });
  await waitFor(() => expect(me).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(section().getAllByRole('listitem')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: 'Ranger / déplacer' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'D\'où sort-elle ?' })).not.toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(locations).not.toHaveBeenCalled();
  expect(recent).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
});

it('sortie depuis la fiche : question avec la pré-sélection de la fiche', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  const group = await screen.findByRole('group', { name: 'D\'où sort-elle ?' });
  expect(within(group).getByRole('radio', { name: 'Cave 2 / B / 3 · 2' })).toBeChecked();
});

describe('Ranger / déplacer', () => {
  it('déplace depuis l’endroit choisi vers l’emplacement saisi, avec la datalist', async () => {
    const getWine = vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'getLocations').mockResolvedValue(cellar);
    const move = vi.spyOn(api, 'moveWine').mockResolvedValue({ locations: detail.locations! });
    const { container } = mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Ranger / déplacer' }));
    const form = within(screen.getByRole('form', { name: 'Ranger / déplacer' }));
    const from = form.getByLabelText('De');
    expect([...(from as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Cave 2 / B / 3 · 2', 'Garage · 1', 'Sans emplacement · 3']);
    await userEvent.selectOptions(from, 'Sans emplacement · 3');
    const zone = form.getByLabelText('Zone');
    await waitFor(() => expect(container.querySelector(`datalist#${CSS.escape(zone.getAttribute('list')!)} option[value="Garage"]`)).not.toBeNull());
    await userEvent.type(zone, 'Cave 2');
    await userEvent.type(form.getByLabelText('Casier'), 'A');
    const qty = form.getByLabelText('Quantité');
    expect(qty).toHaveAttribute('max', '3');
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');
    await userEvent.click(form.getByRole('button', { name: 'Déplacer' }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move).toHaveBeenCalledWith('w1', {
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), from: null, to: { zone: 'Cave 2', casier: 'A', position: null }, quantity: 3,
    });
    await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
  });

  it('affiche tel quel le refus de l’API', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'getLocations').mockResolvedValue(cellar);
    vi.spyOn(api, 'moveWine').mockRejectedValue(new api.ApiError(409, 'Pas assez de bouteilles à cet emplacement'));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Ranger / déplacer' }));
    const form = within(screen.getByRole('form', { name: 'Ranger / déplacer' }));
    await userEvent.type(form.getByLabelText('Zone'), 'Garage');
    await userEvent.click(form.getByRole('button', { name: 'Déplacer' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Pas assez de bouteilles à cet emplacement');
  });
});

describe('inventaire', () => {
  async function count(n: string) {
    await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
    await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
    await userEvent.type(screen.getByLabelText('Bouteilles comptées'), n);
  }

  it('en baisse : demande d’où elles sortent, pré-sélection de la fiche, et l’envoie', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'getLocations').mockResolvedValue(cellar);
    const inventory = vi.spyOn(api, 'postInventory').mockResolvedValue({ movement: { id: 'a1' }, stock: 5, delta: -1, created: true });
    mount();
    await count('5');
    const groups = screen.getAllByRole('group', { name: 'D\'où sort-elle ?' });
    const inv = groups[groups.length - 1];
    expect(within(inv).getByRole('radio', { name: 'Cave 2 / B / 3 · 2' })).toBeChecked();
    await userEvent.click(within(inv).getByRole('radio', { name: 'Garage · 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
    await waitFor(() => expect(inventory).toHaveBeenCalledWith('w1', { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), counted: 5, locationId: 'l2' }));
  });

  it('en hausse : range à l’endroit choisi, « Sans emplacement » par défaut', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'getLocations').mockResolvedValue(cellar);
    const inventory = vi.spyOn(api, 'postInventory').mockResolvedValue({ movement: { id: 'a1' }, stock: 8, delta: 2, created: true });
    mount();
    await count('8');
    const where = screen.getByLabelText('Emplacement');
    expect(where).toHaveValue('');
    await waitFor(() => expect([...(where as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Sans emplacement', 'Cave 2 / B / 3', 'Garage']));
    await userEvent.selectOptions(where, 'Garage');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
    await waitFor(() => expect(inventory).toHaveBeenCalledWith('w1', { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), counted: 8, locationId: 'l2' }));
  });

  it('affiche tel quel le 409 de l’endroit', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'getLocations').mockResolvedValue(cellar);
    vi.spyOn(api, 'postInventory').mockRejectedValue(new api.ApiError(409, 'Pas assez de bouteilles à cet emplacement'));
    mount();
    await count('3');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
    expect(await screen.findByText('Pas assez de bouteilles à cet emplacement')).toBeInTheDocument();
  });
});
