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

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><CampagneReviewPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

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

it('flags an incomplete row, keeps it out of the bulk payload, and mentions it in the dock hint', async () => {
  const incomplete = ext('Domaine Sûr', 0.4, null);
  incomplete.producer = { value: null, confidence: 0.4 };
  vi.spyOn(api, 'getPendingReviewPhotos').mockResolvedValue([
    { id: 'p-ok', status: 'DONE', createdAt: '', extraction: ext('Domaine Sûr', 0.95, 12) },
    { id: 'p-incomplete', status: 'DONE', createdAt: '', extraction: incomplete },
  ]);
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockResolvedValue([
    { ok: true, idempotencyKey: 'x', result: { movement: { id: 'm', delta: 12, type: 'IN', occurredAt: '' }, wine: { id: 'w', producer: 'Domaine Sûr', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 12, created: true } },
  ]);
  renderPage();
  await screen.findAllByRole('article');
  expect(screen.getByText('Producteur requis')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Valider 1 fiche/ })).toBeInTheDocument();
  expect(screen.getByText(/1 fiche incomplète/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Valider 1 fiche/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const items = bulk.mock.calls[0][0];
  expect(items).toHaveLength(1);
  expect(items[0].photoId).toBe('p-ok');
});

it('shows a submit error and keeps the rows when the bulk call rejects', async () => {
  vi.spyOn(api, 'getPendingReviewPhotos').mockResolvedValue([
    { id: 'p-high', status: 'DONE', createdAt: '', extraction: ext('Domaine Sûr', 0.95, 12) },
  ]);
  vi.spyOn(api, 'createMovementsBulk').mockRejectedValue(new api.ApiError(400, 'Liste de mouvements invalide'));
  renderPage();
  await screen.findAllByRole('article');
  await userEvent.click(screen.getByRole('button', { name: /Valider 1 fiche/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Liste de mouvements invalide');
  expect(screen.getAllByRole('article')).toHaveLength(1);
});

it('shows a per-item error badge and a warn status when a bulk item fails', async () => {
  vi.spyOn(api, 'getPendingReviewPhotos').mockResolvedValue([
    { id: 'p-high', status: 'DONE', createdAt: '', extraction: ext('Domaine Sûr', 0.95, 12) },
  ]);
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => [
    { ok: false, idempotencyKey: items[0].idempotencyKey, error: 'il ne reste aucune bouteille de ce vin' },
  ]);
  renderPage();
  await screen.findAllByRole('article');
  await userEvent.click(screen.getByRole('button', { name: /Valider 1 fiche/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('il ne reste aucune bouteille de ce vin')).toBeInTheDocument();
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('0 fiche validée · 1 en erreur');
  expect(status).toHaveClass('badge--warn');
  expect(status).not.toHaveClass('badge--ok');
});
