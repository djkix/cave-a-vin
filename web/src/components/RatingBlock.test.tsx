import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { RatingBlock } from './RatingBlock';

afterEach(() => vi.restoreAllMocks());

const base: api.CaveRow = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  rating: null,
};
const mount = (wine: api.CaveRow) =>
  render(<QueryClientProvider client={new QueryClient()}><RatingBlock wine={wine} /></QueryClientProvider>);

it('propose de noter un vin non noté, puis enregistre une note avec virgule', async () => {
  const set = vi.spyOn(api, 'setRating').mockResolvedValue({ value: 16.5, ratedAt: '2026-10-05T10:00:00Z', ratedBy: 'Franck' });
  mount(base);
  await userEvent.click(screen.getByRole('button', { name: 'Noter ce vin' }));
  await userEvent.type(screen.getByLabelText('Note sur 20'), '16,5');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la note' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith('w1', 16.5));
});

it('bloque une note qui n’est pas un demi-point', async () => {
  mount(base);
  await userEvent.click(screen.getByRole('button', { name: 'Noter ce vin' }));
  await userEvent.type(screen.getByLabelText('Note sur 20'), '16,3');
  expect(screen.getByText('La note se donne par demi-point')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer la note' })).toBeDisabled();
});

it('affiche la note, sa date et son auteur, et la retire', async () => {
  const clear = vi.spyOn(api, 'clearRating').mockResolvedValue(null);
  mount({ ...base, rating: { value: 16.5, ratedAt: '2026-10-05T10:00:00Z', ratedBy: 'Franck' } });
  expect(screen.getByText('16,5 / 20')).toBeInTheDocument();
  expect(screen.getByText('notée le 5 oct. 2026 par Franck')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retirer' }));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('w1'));
});
