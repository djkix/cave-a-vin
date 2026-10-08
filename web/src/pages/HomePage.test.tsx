import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { meFixture, viewerMe } from '../test-fixtures';
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
  expect(await screen.findByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
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

it('mène le propriétaire à « Ma cave »', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [], inProgress: [], failed: [] });
  mount();
  expect(await screen.findByRole('link', { name: 'Ma cave' })).toHaveAttribute('href', '/ma-cave');
  expect(screen.queryByRole('link', { name: /Membres/ })).not.toBeInTheDocument();
});

it('n’offre à un membre en lecture seule que la cave et les statistiques, sans requête réservée', async () => {
  const me = vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  const movements = vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  const inbox = vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [photo('a', 'DONE')], inProgress: [], failed: [] });
  const queue = vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 3, oldestWaitingAt: null, lastReason: null });
  mount();
  expect(await screen.findByRole('link', { name: /Voir la cave/ })).toHaveAttribute('href', '/cave');
  await waitFor(() => expect(me).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(movements).not.toHaveBeenCalled();
  expect(inbox).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: /Rentrer du vin/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Sortir une bouteille/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/à confirmer/)).not.toBeInTheDocument();
  expect(screen.queryByText(/en attente d’analyse/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /journal/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Ma cave' })).not.toBeInTheDocument();
  expect(screen.queryByText('DERNIERS MOUVEMENTS')).not.toBeInTheDocument();
});

it('garde le lien d’administration pour un administrateur membre en lecture seule', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe({ isAdmin: true }));
  mount();
  expect(await screen.findByRole('link', { name: 'Administration' })).toBeInTheDocument();
});

it('montre l’administration seulement à un administrateur', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ isAdmin: false }));
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [], inProgress: [], failed: [] });
  mount();
  await screen.findByRole('link', { name: 'Ma cave' });
  expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();
});

