import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { HomePage } from './HomePage';

afterEach(() => vi.restoreAllMocks());

it('propose Rentrer et marque Sortir comme bientôt disponible', () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
  expect(screen.getByRole('button', { name: /Sortir une bouteille/ })).toBeDisabled();
  expect(screen.getByText(/Bientôt/)).toBeInTheDocument();
});
