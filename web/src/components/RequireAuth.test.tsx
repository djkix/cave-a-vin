import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
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
