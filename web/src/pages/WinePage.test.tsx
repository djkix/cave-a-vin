import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { WinePage } from './WinePage';

afterEach(() => vi.restoreAllMocks());

const detail: api.WineDetail = {
  wine: { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 6 },
  movements: [{ id: 'm1', delta: 6, type: 'IN', occurredAt: '2026-09-21T10:00:00Z', note: null, reversesId: null }],
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cave/w1']}>
        <Routes>
          <Route path="/cave/:wineId" element={<WinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('affiche le vin, son stock et ses derniers mouvements', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
  expect(screen.getByText('6 en stock')).toBeInTheDocument();
  expect(screen.getByText('+6')).toBeInTheDocument();
});

it('annonce l’écart avant de corriger le stock', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory').mockResolvedValue({ movement: { id: 'a1' }, stock: 4, delta: -2, created: true });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '4');
  expect(screen.getByText('−2 bouteilles')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
  await waitFor(() => expect(inventory).toHaveBeenCalledWith('w1', { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), counted: 4 }));
});

it('dit « stock déjà juste » et n’envoie rien quand le compte est identique', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory');
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  expect(screen.getByText('Stock déjà juste')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
  expect(inventory).not.toHaveBeenCalled();
});

it('refuse un compte négatif ou décimal', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '2.5');
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
});

it('montre « Vin introuvable » pour un identifiant inconnu', async () => {
  vi.spyOn(api, 'getWine').mockRejectedValue(new api.ApiError(404, 'Vin introuvable'));
  mount();
  expect(await screen.findByText('Vin introuvable')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Retour à la cave' })).toHaveAttribute('href', '/cave');
});

it('garde le résultat de la sortie affiché après le rafraîchissement du stock', async () => {
  const getWine = vi.spyOn(api, 'getWine')
    .mockResolvedValueOnce(detail)
    .mockResolvedValue({ ...detail, wine: { ...detail.wine, quantity: 5 } });
  vi.spyOn(api, 'createOut').mockResolvedValue({
    movement: { id: 'm2', delta: -1, type: 'OUT', occurredAt: '' },
    wine: detail.wine,
    stock: 5,
    created: true,
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /Sortir 1 bouteille/ }));
  await screen.findByText('Sorti — il en reste 5');
  await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Sorti — il en reste 5')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Annuler la sortie' })).toBeInTheDocument();
});

it('garde le résultat affiché quand la sortie vide le stock', async () => {
  const last = { ...detail, wine: { ...detail.wine, quantity: 1 } };
  const getWine = vi.spyOn(api, 'getWine')
    .mockResolvedValueOnce(last)
    .mockResolvedValue({ ...last, wine: { ...last.wine, quantity: 0 } });
  vi.spyOn(api, 'createOut').mockResolvedValue({
    movement: { id: 'm3', delta: -1, type: 'OUT', occurredAt: '' },
    wine: last.wine,
    stock: 0,
    created: true,
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /Sortir 1 bouteille/ }));
  await screen.findByText('Sorti — il en reste 0');
  await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Sorti — il en reste 0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Annuler la sortie' })).toBeInTheDocument();
});

it('ne propose pas de sortie pour un vin déjà épuisé', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue({ ...detail, wine: { ...detail.wine, quantity: 0 } });
  mount();
  await screen.findByRole('heading', { name: /Domaine Tempier/ });
  expect(screen.queryByRole('button', { name: /Sortir/ })).not.toBeInTheDocument();
});
