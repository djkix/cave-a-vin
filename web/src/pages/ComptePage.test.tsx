import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { APP_VERSION } from '../lib/version';
import { meFixture, OWNER_CAVE, VIEWER_CAVE, viewerMe } from '../test-fixtures';
import { ComptePage } from './ComptePage';

afterEach(() => vi.restoreAllMocks());

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/compte']}>
        <ComptePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('affiche la version, la déconnexion et la sauvegarde Excel au propriétaire', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture());
  const out = vi.spyOn(api, 'logout').mockResolvedValue({ ok: true });
  mount();
  expect(await screen.findByRole('link', { name: /Télécharger la sauvegarde Excel/ })).toHaveAttribute('href', '/api/export.xlsx');
  expect(screen.getByLabelText(`Version ${APP_VERSION}`)).toHaveTextContent(`Version ${APP_VERSION}`);
  await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));
  await waitFor(() => expect(out).toHaveBeenCalled());
});

it('ne propose pas la sauvegarde à un membre en lecture seule, mais la déconnexion oui', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  mount();
  expect(await screen.findByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /sauvegarde Excel/ })).not.toBeInTheDocument();
});

it('liste les caves, dont celles où l’on est invité, et permet d’en afficher une autre', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ caves: [OWNER_CAVE, VIEWER_CAVE], currentCaveId: OWNER_CAVE.id }));
  const set = vi.spyOn(api, 'setCurrentCave').mockResolvedValue(meFixture({ caves: [OWNER_CAVE, VIEWER_CAVE], currentCaveId: VIEWER_CAVE.id }));
  mount();
  expect(await screen.findByText('Cave de Paul')).toBeInTheDocument();
  expect(screen.getByText('Invité, lecture seule')).toBeInTheDocument();
  expect(screen.getByText('Cave affichée')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Afficher' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith(VIEWER_CAVE.id));
});

it('mène à l’Administration pour un administrateur seulement', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ isAdmin: true }));
  mount();
  expect(await screen.findByRole('link', { name: 'Administration' })).toHaveAttribute('href', '/admin');
});

it('explique comment installer l’application quand le navigateur ne la propose pas', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture());
  mount();
  expect(await screen.findByText('Application sur le téléphone')).toBeInTheDocument();
  // jsdom : ni invitation du navigateur, ni iPhone, ni mode installé.
  expect(screen.getByText(/Ouvrez le menu du navigateur/)).toBeInTheDocument();
});
