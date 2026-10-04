import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieConfirmation } from './SortieConfirmation';

afterEach(() => vi.restoreAllMocks());

const wine: api.CaveRow = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019,
  color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 3,
};
const result = (stock: number): api.MovementResult => ({
  movement: { id: 'm1', delta: -1, type: 'OUT', occurredAt: '' }, wine: { ...wine, cuvee: wine.cuvee }, stock, created: true,
});

function mount(props: Partial<Parameters<typeof SortieConfirmation>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SortieConfirmation wine={wine} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('sort une bouteille par défaut et annonce le stock restant', async () => {
  const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
  mount({ photoId: 'px' });
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  await waitFor(() => expect(out).toHaveBeenCalledTimes(1));
  expect(out.mock.calls[0][0]).toMatchObject({ wineId: 'w1', quantity: 1, photoId: 'px' });
  expect(out.mock.calls[0][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('Sorti — il en reste 2')).toBeInTheDocument();
});

it('borne la quantité au stock', async () => {
  mount();
  const more = screen.getByRole('button', { name: 'Une bouteille de plus' });
  await userEvent.click(more);
  await userEvent.click(more);
  await userEvent.click(more);
  expect(screen.getByRole('button', { name: /Sortir 3 bouteilles/ })).toBeInTheDocument();
  expect(more).toBeDisabled();
});

it('envoie une seule sortie sur un double tap', async () => {
  const out = vi.spyOn(api, 'createOut').mockImplementation(() => new Promise((r) => setTimeout(() => r(result(2)), 20)));
  mount();
  const button = screen.getByRole('button', { name: /Sortir 1 bouteille/ });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText('Sorti — il en reste 2');
  expect(out).toHaveBeenCalledTimes(1);
});

it('affiche en clair un stock devenu insuffisant, sans rien sortir', async () => {
  vi.spyOn(api, 'createOut').mockRejectedValue(new api.ApiError(409, 'Il n’en reste que 0'));
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Il n’en reste que 0');
  expect(screen.queryByText(/Sorti —/)).not.toBeInTheDocument();
});

it('annule la sortie depuis le message de résultat', async () => {
  vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
  const cancel = vi.spyOn(api, 'cancelMovement').mockResolvedValue(result(3));
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Annuler la sortie' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('m1', expect.stringMatching(/^[0-9a-f-]{36}$/)));
  expect(await screen.findByText('Sortie annulée — 3 en stock')).toBeInTheDocument();
});
