import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { AdminPage } from './AdminPage';

afterEach(() => vi.restoreAllMocks());

const me: api.Me = { id: 'u1', email: 'admin@example.com', displayName: 'Admin', isAdmin: true, status: 'ACTIVE' };
const users: api.AdminUser[] = [
  { id: 'u1', email: 'admin@example.com', displayName: 'Admin', status: 'ACTIVE', isAdmin: true, isBreakGlass: false, createdAt: '2026-01-01T00:00:00Z', lastLoginAt: '2026-02-01T00:00:00Z' },
  { id: 'u2', email: 'other@example.com', displayName: 'Other', status: 'ACTIVE', isAdmin: false, isBreakGlass: false, createdAt: '2026-01-02T00:00:00Z', lastLoginAt: null },
];

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin']}>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('lists accounts and blocks another account on click', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(me);
  vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
  const update = vi.spyOn(api, 'updateAdminUser').mockResolvedValue({ ...users[1], status: 'BLOCKED' });

  mount();

  expect(await screen.findByText('other@example.com')).toBeInTheDocument();
  expect(screen.getByText('admin@example.com')).toBeInTheDocument();

  const rows = screen.getAllByText(/@example\.com/).map((el) => el.closest<HTMLElement>('.list__row'));
  const otherRow = rows.find((r) => r?.textContent?.includes('other@example.com'))!;
  await userEvent.click(within(otherRow).getByRole('button', { name: 'Bloquer' }));

  await waitFor(() => expect(update).toHaveBeenCalledWith('u2', { status: 'BLOCKED' }));
});

it('disables the actions on the current admin’s own row', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(me);
  vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);

  mount();

  await screen.findByText('other@example.com');
  const rows = screen.getAllByText(/@example\.com/).map((el) => el.closest<HTMLElement>('.list__row'));
  const selfRow = rows.find((r) => r?.textContent?.includes('admin@example.com'))!;
  expect(within(selfRow).getByRole('button', { name: 'Bloquer' })).toBeDisabled();
  expect(within(selfRow).getByRole('button', { name: 'Retirer les droits' })).toBeDisabled();
  expect(within(selfRow).getByText('votre compte')).toBeInTheDocument();
});

it('shows the reserved message for a non-administrator, without fetching the user list', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue({ ...me, isAdmin: false });
  const list = vi.spyOn(api, 'getAdminUsers');

  mount();

  expect(await screen.findByText('Réservé à l’administrateur.')).toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
});
