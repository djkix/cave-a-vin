import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import * as sse from '../lib/sse';
import { EntreeConfirmationPage } from './EntreeConfirmationPage';

const extraction: api.WineExtraction = {
  producer: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: 'La Tourtine', confidence: 0.95 },
  appellation: { value: 'Bandol', confidence: 0.97 }, vintage: { value: 2019, confidence: 0.5 },
  color: { value: 'ROUGE', confidence: 0.99 }, formatCl: { value: 75, confidence: 0.9 },
  bottlesPerCase: { value: 6, confidence: 0.85 }, globalConfidence: 0.93,
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/entree/p1']}>
        <Routes>
          <Route path="/entree/:photoId" element={<EntreeConfirmationPage />} />
          <Route path="/" element={<p>Accueil</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('waits for extraction, prefills the form, then writes one IN movement on confirm', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'PENDING', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation((_id, onEvent) => { onEvent({ status: 'DONE', extraction }); return () => {}; });
  const create = vi.spyOn(api, 'createMovement').mockResolvedValue({ movement: { id: 'm1', delta: 6, type: 'IN', occurredAt: '' }, wine: { id: 'w1', producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 6, created: true });

  mount();
  expect(await screen.findByDisplayValue('Domaine Tempier')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^6/ })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(screen.getByRole('button', { name: /Confirmer l’entrée \(\+6 bouteilles\)/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const input = create.mock.calls[0][0];
  expect(input.quantity).toBe(6);
  expect(input.photoId).toBe('p1');
  expect(input.wine.producer).toBe('Domaine Tempier');
  expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText(/Stock : 6/)).toBeInTheDocument();
});

it('shows the failure and a manual-entry fallback when extraction fails', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'FAILED', errorMessage: 'Plafond mensuel atteint', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  mount();
  expect(await screen.findByText(/Plafond mensuel atteint/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Saisir à la main/ })).toBeInTheDocument();
});
