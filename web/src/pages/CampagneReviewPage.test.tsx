import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { CampagneReviewPage } from './CampagneReviewPage';

afterEach(() => vi.restoreAllMocks());

const ext = (producer: string, conf: number, qty: number | null): api.WineExtraction => ({
  producer: { value: producer, confidence: conf }, cuvee: { value: null, confidence: 0 }, appellation: { value: 'Bandol', confidence: conf },
  vintage: { value: 2019, confidence: conf }, color: { value: 'ROUGE', confidence: 1 }, formatCl: { value: 75, confidence: 1 },
  bottlesPerCase: { value: qty, confidence: 0.8 }, globalConfidence: conf,
});

it('lists low-confidence first and bulk-confirms the kept rows', async () => {
  vi.spyOn(api, 'getPendingReviewPhotos').mockResolvedValue([
    { id: 'p-high', status: 'DONE', createdAt: '', extraction: ext('Domaine Sûr', 0.95, 12) },
    { id: 'p-low', status: 'DONE', createdAt: '', extraction: ext('Domaine Douteux', 0.4, null) },
  ]);
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockResolvedValue([
    { ok: true, idempotencyKey: 'x', result: { movement: { id: 'm', delta: 12, type: 'IN', occurredAt: '' }, wine: { id: 'w', producer: 'Domaine Sûr', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 12, created: true } },
  ]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><CampagneReviewPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  const rows = await screen.findAllByRole('article');
  expect(within(rows[0]).getByDisplayValue('Domaine Douteux')).toBeInTheDocument();
  await userEvent.click(within(rows[0]).getByRole('button', { name: /Ignorer/ }));
  await userEvent.click(screen.getByRole('button', { name: /Valider 1 fiche/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const items = bulk.mock.calls[0][0];
  expect(items).toHaveLength(1);
  expect(items[0].photoId).toBe('p-high');
  expect(items[0].quantity).toBe(12);
  expect(await screen.findByText(/1 fiche validée/)).toBeInTheDocument();
});
