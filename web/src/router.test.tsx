import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import * as api from './lib/api-client';
import { routes } from './router';
import { meFixture, viewerMe } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

function mountAt(path: string, me = meFixture()) {
  vi.spyOn(api, 'getMe').mockResolvedValue(me);
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue({ toConfirm: [], inProgress: [], failed: [] });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

it('redirige l’ancien mode campagne vers la rafale', async () => {
  const router = mountAt('/entree/campagne');
  await waitFor(() => expect(router.state.location.pathname).toBe('/entree'));
  expect(await screen.findByLabelText('Prendre une photo')).toBeInTheDocument();
});

it('redirige l’ancienne revue groupée vers « À confirmer »', async () => {
  const router = mountAt('/entree/campagne/revue');
  await waitFor(() => expect(router.state.location.pathname).toBe('/a-confirmer'));
  expect(await screen.findByText(/Aucun vin à confirmer/)).toBeInTheDocument();
});

describe('membre en lecture seule', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getCave').mockResolvedValue([]);
    vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
    vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 0, oldestWaitingAt: null, lastReason: null });
  });

  it.each(['/entree', '/entree/p1', '/sortie', '/sortie/p1', '/journal', '/a-confirmer', '/membres'])(
    'renvoie %s vers l’accueil',
    async (path) => {
      const router = mountAt(path, viewerMe());
      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
      expect(await screen.findByLabelText('Navigation principale')).toBeInTheDocument();
    },
  );

  it('laisse la cave et les statistiques ouvertes', async () => {
    const router = mountAt('/cave', viewerMe());
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/cave');
  });
});

it('ouvre l’écran Membres au propriétaire', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue([]);
  const router = mountAt('/membres');
  expect(await screen.findByRole('heading', { name: 'Membres' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/membres');
});
