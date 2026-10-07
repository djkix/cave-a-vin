import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import * as sender from '../lib/photo-sender';
import { APP_VERSION } from '../lib/version';
import { meFixture, viewerMe } from '../test-fixtures';
import { RequireAuth } from './RequireAuth';

afterEach(() => vi.restoreAllMocks());

function mount(path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<p>Protégé</p>} />
            <Route path="/admin" element={<p>Page d’administration</p>} />
          </Route>
          <Route path="/login" element={<p>Connexion</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('redirects a blocked account (403 on /auth/me) to /login, same as a 401', async () => {
  vi.spyOn(api, 'getMe').mockRejectedValue(new api.ApiError(403, 'Compte bloqué'));
  mount();
  expect(await screen.findByText('Connexion')).toBeInTheDocument();
});

it('lance l’envoi en arrière-plan des photos sur toute page protégée, une fois connecté', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture());
  const send = vi.spyOn(sender, 'sendQueuedPhotos').mockResolvedValue(undefined);
  mount();
  expect(await screen.findByText('Protégé')).toBeInTheDocument();
  expect(send).toHaveBeenCalledTimes(1);
});

it('n’envoie rien sans session', async () => {
  vi.spyOn(api, 'getMe').mockRejectedValue(new api.ApiError(401, 'Non connecté'));
  const send = vi.spyOn(sender, 'sendQueuedPhotos').mockResolvedValue(undefined);
  mount();
  expect(await screen.findByText('Connexion')).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});

it('montre l’écran d’attente à un compte PENDING, avec la version et la déconnexion', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ status: 'PENDING', caves: [], currentCaveId: null }));
  const out = vi.spyOn(api, 'logout').mockResolvedValue({ ok: true });
  const send = vi.spyOn(sender, 'sendQueuedPhotos').mockResolvedValue(undefined);
  mount();
  expect(await screen.findByText(/^Inscription en attente de validation — vous serez prévenu/)).toBeInTheDocument();
  expect(screen.queryByText('Protégé')).not.toBeInTheDocument();
  expect(screen.getByLabelText(`Version ${APP_VERSION}`)).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));
  await waitFor(() => expect(out).toHaveBeenCalled());
  expect(await screen.findByText('Connexion')).toBeInTheDocument();
});

it('dit à un compte actif sans cave qu’il n’en a pas encore, sans lien d’administration', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ caves: [], currentCaveId: null }));
  mount();
  expect(
    await screen.findByText('Vous n’avez pas encore de cave. Un administrateur peut vous en créer une, ou un propriétaire peut vous inviter.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('Protégé')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();
});

it('laisse un administrateur sans cave rejoindre l’administration', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ isAdmin: true, caves: [], currentCaveId: null }));
  mount();
  const link = await screen.findByRole('link', { name: 'Administration' });
  expect(link).toHaveAttribute('href', '/admin');
  await userEvent.click(link);
  expect(await screen.findByText('Page d’administration')).toBeInTheDocument();
});

it('n’envoie pas la file de photos pour un membre en lecture seule', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  const send = vi.spyOn(sender, 'sendQueuedPhotos').mockResolvedValue(undefined);
  mount();
  expect(await screen.findByText('Protégé')).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});
