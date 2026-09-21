import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { JournalPage } from './JournalPage';

const wine = { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019 };

it('lists movements, cancels with an inverse movement and never shows Annuler on a reversal', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([
    { id: 'm2', delta: -6, type: 'ADJUST', occurredAt: '2026-09-20T10:00:00Z', note: 'Annulation du mouvement m0', reversesId: 'm0', wine },
    { id: 'm1', delta: 12, type: 'IN', occurredAt: '2026-09-19T10:00:00Z', note: null, reversesId: null, wine },
  ]);
  const cancel = vi.spyOn(api, 'cancelMovement').mockResolvedValue({ movement: { id: 'm3', delta: -12, type: 'ADJUST', occurredAt: '' }, wine: { ...wine, color: 'ROUGE', formatCl: 75 }, stock: 0, created: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><JournalPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('+12')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Annuler/ })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: /Annuler/ }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('m1', expect.stringMatching(/^[0-9a-f-]{36}$/)));
  expect(screen.getByRole('link', { name: /Exporter le classeur/ })).toHaveAttribute('href', '/api/export.xlsx');
});
