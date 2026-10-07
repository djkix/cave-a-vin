import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { meFixture } from '../test-fixtures';
import { AdminPage } from './AdminPage';

afterEach(() => vi.restoreAllMocks());

const me: api.Me = meFixture({ id: 'u1', email: 'admin@example.com', displayName: 'Admin', isAdmin: true });
const users: api.AdminUser[] = [
  { id: 'u1', email: 'admin@example.com', displayName: 'Admin', status: 'ACTIVE', isAdmin: true, isBreakGlass: false, createdAt: '2026-01-01T00:00:00Z', lastLoginAt: '2026-02-01T00:00:00Z', hasCave: true },
  { id: 'u2', email: 'other@example.com', displayName: 'Other', status: 'ACTIVE', isAdmin: false, isBreakGlass: false, createdAt: '2026-01-02T00:00:00Z', lastLoginAt: null, hasCave: true },
];
const budget: api.AdminBudget = { caveShare: 0.2, capCents: 500, spentThisMonthCents: 123 };

// Sections ajoutées par les caves : réponses neutres par défaut, chaque test les remplace au besoin.
beforeEach(() => {
  vi.spyOn(api, 'getRegistrations').mockResolvedValue([]);
  vi.spyOn(api, 'getAdminBudget').mockResolvedValue(budget);
  vi.spyOn(api, 'getReadingQuality').mockResolvedValue({ days: 30, entries: 0, rate: null, fields: [] });
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: [], qualities: [] });
  vi.spyOn(api, 'searchGuards').mockResolvedValue([]);
});

const rowOf = (text: string) => screen.getAllByText(text)[0].closest<HTMLElement>('.list__row')!;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin']}>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
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

describe('Inscriptions', () => {
  const registrations: api.Registration[] = [
    { id: 'r1', email: 'lea@example.com', displayName: 'Léa Martin', createdAt: '2026-10-03T08:30:00Z' },
    { id: 'r2', email: 'zoe@example.com', displayName: null, createdAt: '2026-10-05T18:00:00Z' },
  ];

  it('liste les inscriptions en attente avec nom, e-mail et date', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    vi.spyOn(api, 'getRegistrations').mockResolvedValue(registrations);
    mount();
    expect(await screen.findByRole('heading', { name: 'Inscriptions' })).toBeInTheDocument();
    await screen.findByText('lea@example.com');
    const lea = within(rowOf('lea@example.com'));
    expect(lea.getByText('Léa Martin')).toBeInTheDocument();
    expect(lea.getByText(/3 oct\.? 2026/)).toBeInTheDocument();
    const zoe = within(rowOf('zoe@example.com'));
    expect(zoe.queryByText(/null/)).not.toBeInTheDocument();
    expect(zoe.getByRole('button', { name: 'Valider' })).toBeInTheDocument();
    expect(zoe.getByRole('button', { name: 'Refuser' })).toBeInTheDocument();
  });

  it('dit qu’aucune inscription n’attend', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    mount();
    expect(await screen.findByText('Aucune inscription en attente')).toBeInTheDocument();
  });

  it('valide une inscription puis relit inscriptions et comptes', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    const list = vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    const regs = vi.spyOn(api, 'getRegistrations').mockResolvedValue(registrations);
    const validate = vi.spyOn(api, 'validateRegistration').mockResolvedValue({ id: 'r1', status: 'ACTIVE', cave: { id: 'c9', name: 'Cave de Léa Martin' } });
    mount();
    await screen.findByText('lea@example.com');
    await userEvent.click(within(rowOf('lea@example.com')).getByRole('button', { name: 'Valider' }));
    await waitFor(() => expect(validate).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(regs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('refuse une inscription seulement après confirmation', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    vi.spyOn(api, 'getRegistrations').mockResolvedValue(registrations);
    const refuse = vi.spyOn(api, 'refuseRegistration').mockResolvedValue({ id: 'r2', status: 'BLOCKED' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount();
    await screen.findByText('zoe@example.com');
    const button = within(rowOf('zoe@example.com')).getByRole('button', { name: 'Refuser' });
    await userEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('zoe@example.com'));
    expect(refuse).not.toHaveBeenCalled();
    await userEvent.click(button);
    await waitFor(() => expect(refuse).toHaveBeenCalledWith('r2'));
  });

  it('affiche tel quel le refus de l’api', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    vi.spyOn(api, 'getRegistrations').mockResolvedValue(registrations);
    vi.spyOn(api, 'validateRegistration').mockRejectedValue(new api.ApiError(404, 'Inscription introuvable'));
    mount();
    await screen.findByText('lea@example.com');
    await userEvent.click(within(rowOf('lea@example.com')).getByRole('button', { name: 'Valider' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Inscription introuvable');
  });
});

describe('Créer sa cave', () => {
  const withoutCave: api.AdminUser[] = [
    users[0],
    { ...users[1], hasCave: false },
    { id: 'u3', email: 'blocked@example.com', displayName: null, status: 'BLOCKED', isAdmin: false, isBreakGlass: false, createdAt: '2026-01-03T00:00:00Z', lastLoginAt: null, hasCave: false },
  ];

  it('n’est proposé qu’aux comptes actifs sans cave, et crée la cave', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    const list = vi.spyOn(api, 'getAdminUsers').mockResolvedValue(withoutCave);
    const create = vi.spyOn(api, 'createUserCave').mockResolvedValue({ id: 'c9', name: 'Cave de Other' });
    mount();
    await screen.findByText('other@example.com');
    expect(within(rowOf('admin@example.com')).queryByRole('button', { name: 'Créer sa cave' })).not.toBeInTheDocument();
    expect(within(rowOf('blocked@example.com')).queryByRole('button', { name: 'Créer sa cave' })).not.toBeInTheDocument();
    await userEvent.click(within(rowOf('other@example.com')).getByRole('button', { name: 'Créer sa cave' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('u2'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('affiche le refus de l’api', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(withoutCave);
    vi.spyOn(api, 'createUserCave').mockRejectedValue(new api.ApiError(409, 'Ce compte a déjà une cave'));
    mount();
    await screen.findByText('other@example.com');
    await userEvent.click(within(rowOf('other@example.com')).getByRole('button', { name: 'Créer sa cave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ce compte a déjà une cave');
  });
});

describe('Budget', () => {
  it('montre la dépense du mois, le plafond, la part en pourcentage et la cave exemptée', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    mount();
    expect(await screen.findByText(/Dépensé ce mois : 1,23\s€ sur 5,00\s€/)).toBeInTheDocument();
    expect(screen.getByLabelText('Part maximale par cave (%)')).toHaveValue(20);
    expect(screen.getByText('La cave de l’administrateur principal n’est pas limitée.')).toBeInTheDocument();
  });

  it('enregistre la part en fraction (35 % → 0,35)', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    const put = vi.spyOn(api, 'putAdminBudget').mockResolvedValue({ ...budget, caveShare: 0.35 });
    mount();
    const input = await screen.findByLabelText('Part maximale par cave (%)');
    await waitFor(() => expect(input).toHaveValue(20));
    await userEvent.clear(input);
    await userEvent.type(input, '35');
    await userEvent.click(within(screen.getByRole('heading', { name: 'Budget' }).closest('section')!).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(0.35));
  });

  it('refuse une part hors de 0 à 100 ou non entière, sans appel', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    const put = vi.spyOn(api, 'putAdminBudget');
    mount();
    const input = await screen.findByLabelText('Part maximale par cave (%)');
    await waitFor(() => expect(input).toHaveValue(20));
    const save = within(screen.getByRole('heading', { name: 'Budget' }).closest('section')!).getByRole('button', { name: 'Enregistrer' });
    for (const bad of ['101', '12.5']) {
      await userEvent.clear(input);
      await userEvent.type(input, bad);
      expect(save).toBeDisabled();
      expect(screen.getByText('Entrez un pourcentage entier entre 0 et 100')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    await userEvent.clear(input);
    expect(save).toBeDisabled();
    await userEvent.type(input, '0');
    expect(save).toBeEnabled();
    expect(screen.queryByText('Entrez un pourcentage entier entre 0 et 100')).not.toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it('affiche tel quel le refus de l’api', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(me);
    vi.spyOn(api, 'getAdminUsers').mockResolvedValue(users);
    vi.spyOn(api, 'putAdminBudget').mockRejectedValue(new api.ApiError(400, 'La part par cave doit être comprise entre 0 et 1'));
    mount();
    const input = await screen.findByLabelText('Part maximale par cave (%)');
    await waitFor(() => expect(input).toHaveValue(20));
    await userEvent.click(within(screen.getByRole('heading', { name: 'Budget' }).closest('section')!).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La part par cave doit être comprise entre 0 et 1');
  });
});

it('ne demande ni inscriptions ni budget à un non-administrateur', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue({ ...me, isAdmin: false });
  const regs = vi.spyOn(api, 'getRegistrations');
  const budgetCall = vi.spyOn(api, 'getAdminBudget');
  mount();
  expect(await screen.findByText('Réservé à l’administrateur.')).toBeInTheDocument();
  expect(regs).not.toHaveBeenCalled();
  expect(budgetCall).not.toHaveBeenCalled();
});
