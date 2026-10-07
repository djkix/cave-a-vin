import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import * as api from './lib/api-client';
import { routes } from './router';
import userEvent from '@testing-library/user-event';
import { meFixture, OWNER_CAVE, VIEWER_CAVE, viewerMe } from './test-fixtures';

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

describe('changement de cave', () => {
  const twoCaves = meFixture({ caves: [OWNER_CAVE, VIEWER_CAVE], currentCaveId: OWNER_CAVE.id });
  const wineA: api.CaveRow = {
    id: 'wa', producer: 'Domaine de la Cave A', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 3,
  };

  function switchable() {
    vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 0, oldestWaitingAt: null, lastReason: null });
    vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
    const viewerSession = { ...twoCaves, currentCaveId: VIEWER_CAVE.id };
    vi.spyOn(api, 'setCurrentCave').mockImplementation(async () => {
      vi.mocked(api.getMe).mockResolvedValue(viewerSession);
      return viewerSession;
    });
  }

  it('n’affiche jamais un vin de l’ancienne cave pendant le chargement de la nouvelle', async () => {
    const getCave = vi.spyOn(api, 'getCave').mockResolvedValueOnce([wineA]).mockReturnValue(new Promise(() => {}));
    switchable();
    const router = mountAt('/cave', twoCaves);
    expect(await screen.findByText(/Domaine de la Cave A/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Cave' }), 'c2');
    await waitFor(() => expect(getCave).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Domaine de la Cave A/)).not.toBeInTheDocument();
    expect(await screen.findByText('Lecture seule')).toBeInTheDocument();
    expect(screen.queryByText(/Domaine de la Cave A/)).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/cave');
  });

  it('quitte le journal vers une cave en lecture sans relancer le journal', async () => {
    switchable();
    const router = mountAt('/journal', twoCaves);
    const movements = vi.mocked(api.getRecentMovements);
    await waitFor(() => expect(movements).toHaveBeenCalled());
    const before = movements.mock.calls.length;
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cave' }), 'c2');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Lecture seule')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(movements).toHaveBeenCalledTimes(before);
  });

  it('depuis l’accueil, ne relance ni « à confirmer » ni la file d’analyse pour une cave en lecture', async () => {
    switchable();
    mountAt('/', twoCaves);
    const inbox = vi.mocked(api.getEntryInbox);
    const queue = vi.mocked(api.getPhotoQueueStatus);
    const movements = vi.mocked(api.getRecentMovements);
    await waitFor(() => expect(inbox).toHaveBeenCalled());
    await waitFor(() => expect(queue).toHaveBeenCalled());
    const counts = [inbox.mock.calls.length, queue.mock.calls.length, movements.mock.calls.length];
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cave' }), 'c2');
    expect(await screen.findByRole('link', { name: /Voir la cave/ })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect([inbox.mock.calls.length, queue.mock.calls.length, movements.mock.calls.length]).toEqual(counts);
  });

  it('relit les listes de la nouvelle cave quand on y reste propriétaire', async () => {
    const otherOwned = { id: 'c3', name: 'Cave du Var', role: 'OWNER' as const };
    const me = meFixture({ caves: [OWNER_CAVE, otherOwned], currentCaveId: OWNER_CAVE.id });
    vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 0, oldestWaitingAt: null, lastReason: null });
    const movements = vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
    vi.spyOn(api, 'setCurrentCave').mockImplementation(async () => {
      vi.mocked(api.getMe).mockResolvedValue({ ...me, currentCaveId: 'c3' });
      return { ...me, currentCaveId: 'c3' };
    });
    const router = mountAt('/journal', me);
    await waitFor(() => expect(movements).toHaveBeenCalledTimes(1));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cave' }), 'c3');
    await waitFor(() => expect(movements).toHaveBeenCalledTimes(2));
    expect(router.state.location.pathname).toBe('/journal');
  });
});
