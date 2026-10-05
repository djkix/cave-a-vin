import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { HomePage } from './HomePage';

afterEach(() => vi.restoreAllMocks());

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const photo = (id: string, status: api.PhotoDto['status']): api.PhotoDto => ({ id, status, createdAt: '' });

it('propose Rentrer et Sortir, sans mode campagne', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  const inbox = vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [], inProgress: [], failed: [] });
  mount();
  expect(screen.getByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
  expect(screen.getByRole('link', { name: /Sortir une bouteille/ })).toHaveAttribute('href', '/sortie');
  expect(screen.queryByText(/Bientôt/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Mode campagne/)).not.toBeInTheDocument();
  await waitFor(() => expect(inbox).toHaveBeenCalled());
});

it('affiche le badge des vins à confirmer (à valider + lecture impossible)', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue({
    toConfirm: [photo('a', 'DONE'), photo('b', 'DONE')],
    inProgress: [photo('c', 'PENDING')],
    failed: [photo('d', 'FAILED')],
  });
  mount();
  expect(await screen.findByRole('link', { name: /3 vins à confirmer/ })).toHaveAttribute('href', '/a-confirmer');
});

it('accorde le badge au singulier', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [], inProgress: [], failed: [photo('d', 'FAILED')] });
  mount();
  expect(await screen.findByRole('link', { name: /1 vin à confirmer/ })).toBeInTheDocument();
});

it('masque le badge quand rien n’est à confirmer', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  const inbox = vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [], inProgress: [photo('c', 'PENDING')], failed: [] });
  mount();
  await waitFor(() => expect(inbox).toHaveBeenCalled());
  expect(screen.queryByText(/à confirmer/)).not.toBeInTheDocument();
});
