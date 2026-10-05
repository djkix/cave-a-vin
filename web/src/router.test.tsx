import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import * as api from './lib/api-client';
import { routes } from './router';

afterEach(() => vi.restoreAllMocks());

function mountAt(path: string) {
  vi.spyOn(api, 'getMe').mockResolvedValue({ id: 'u', email: 'a@b.c', displayName: null, isAdmin: false, status: 'ACTIVE' });
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
