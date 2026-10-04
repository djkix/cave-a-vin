import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieCapturePage } from './SortieCapturePage';

afterEach(() => vi.restoreAllMocks());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/sortie']}>
      <Routes>
        <Route path="/sortie" element={<SortieCapturePage />} />
        <Route path="/sortie/:photoId" element={<p>Résolution</p>} />
      </Routes>
    </MemoryRouter>,
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
