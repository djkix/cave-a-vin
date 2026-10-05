import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import * as sender from '../lib/photo-sender';
import { RequireAuth } from './RequireAuth';

afterEach(() => vi.restoreAllMocks());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<p>Protégé</p>} />
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
  vi.spyOn(api, 'getMe').mockResolvedValue({ id: 'u', email: 'a@b.c', role: 'USER' } as never);
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
