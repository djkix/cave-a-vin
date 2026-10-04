import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { HomePage } from './HomePage';

afterEach(() => vi.restoreAllMocks());

it('propose Rentrer et Sortir', () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
  expect(screen.getByRole('link', { name: /Sortir une bouteille/ })).toHaveAttribute('href', '/sortie');
  expect(screen.queryByText(/Bientôt/)).not.toBeInTheDocument();
});
