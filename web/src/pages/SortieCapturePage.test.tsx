import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieCapturePage } from './SortieCapturePage';

afterEach(() => vi.restoreAllMocks());

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/sortie']}>
        <Routes>
          <Route path="/sortie" element={<SortieCapturePage />} />
          <Route path="/sortie/:photoId" element={<p>Résolution</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('envoie la photo comme photo de sortie puis ouvre la résolution', async () => {
  const upload = vi.spyOn(api, 'uploadPhoto').mockResolvedValue({ id: 'p9', status: 'PENDING', duplicate: false });
  mount();
  await userEvent.upload(screen.getByLabelText('Photographier l’étiquette'), new File(['x'], 'b.jpg', { type: 'image/jpeg' }));
  await waitFor(() => expect(upload).toHaveBeenCalledWith(expect.any(File), 'EXIT'));
  expect(await screen.findByText('Résolution')).toBeInTheDocument();
});

it('propose la recherche dans la cave quand l’envoi échoue', async () => {
  vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new Error('Réseau indisponible'));
  mount();
  await userEvent.upload(screen.getByLabelText('Photographier l’étiquette'), new File(['x'], 'b.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible');
  expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toHaveAttribute('href', '/cave');
});

it('réessaie l’envoi de la même photo puis ouvre la résolution', async () => {
  const file = new File(['x'], 'b.jpg', { type: 'image/jpeg' });
  const upload = vi
    .spyOn(api, 'uploadPhoto')
    .mockRejectedValueOnce(new Error('Réseau indisponible'))
    .mockResolvedValueOnce({ id: 'p9', status: 'PENDING', duplicate: false });
  mount();
  await userEvent.upload(screen.getByLabelText('Photographier l’étiquette'), file);
  expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible');
  await userEvent.click(screen.getByRole('button', { name: 'Réessayer l’envoi' }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(upload).toHaveBeenNthCalledWith(2, file, 'EXIT');
  expect(await screen.findByText('Résolution')).toBeInTheDocument();
});
