import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { meFixture, viewerMe } from '../test-fixtures';
import { BottomNav } from './BottomNav';

afterEach(() => vi.restoreAllMocks());

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <BottomNav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const labels = () => screen.getAllByRole('link').map((l) => l.textContent);

it('montre les cinq onglets au propriétaire', async () => {
  mount();
  expect(await screen.findByRole('link', { name: /Journal/ })).toBeInTheDocument();
  expect(labels()).toEqual(['shelvesCave', 'add_circleEntrée', 'remove_circle_outlineSortie', 'history_eduJournal', 'bar_chartStats']);
});

it('ne garde que Cave et Stats pour un membre en lecture seule', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  mount();
  expect(await screen.findByRole('link', { name: /Stats/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Cave/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Entrée/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Sortie/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Journal/ })).not.toBeInTheDocument();
});

it('disparaît pour un compte sans cave (administrateur sans cave dans l’administration)', async () => {
  const me = vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ isAdmin: true, caves: [], currentCaveId: null }));
  mount();
  await waitFor(() => expect(me).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByLabelText('Navigation principale')).not.toBeInTheDocument();
});
