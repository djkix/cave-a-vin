import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import * as queue from '../lib/offline-queue';
import { _resetForTests, QueueFullError, queueStats } from '../lib/offline-queue';
import * as sender from '../lib/photo-sender';
import { _resetSenderForTests, setSenderAccount } from '../lib/photo-sender';
import { EntreeCapturePage } from './EntreeCapturePage';

beforeEach(async () => {
  await _resetForTests();
  _resetSenderForTests();
  // Posé par RequireAuth dans l'application : le propriétaire connecté.
  setSenderAccount('u1');
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetSenderForTests();
});

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <EntreeCapturePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const photo = (n: number) => new File([new Uint8Array(10 + n)], `p${n}.jpg`, { type: 'image/jpeg' });

it('range trois photos dans la file sans attendre aucun envoi, et compte 3', async () => {
  // L'envoi ne répond jamais : si l'écran l'attendait, le compteur resterait bloqué.
  const upload = vi.spyOn(api, 'uploadPhoto').mockReturnValue(new Promise(() => {}));
  const enqueue = vi.spyOn(queue, 'enqueuePhoto');
  const kick = vi.spyOn(sender, 'kickSender');
  mount();
  // La session (/auth/me) est chargée avant toute photo, comme derrière RequireAuth.
  await waitFor(() => expect(api.getMe).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));

  const input = screen.getByLabelText('Prendre une photo');
  expect(input).toHaveAttribute('accept', 'image/*');
  expect(input).toHaveAttribute('capture', 'environment');
  expect(screen.getByRole('button', { name: /Prendre une photo/ })).toBeInTheDocument();

  fireEvent.change(input, { target: { files: [photo(1)] } });
  fireEvent.change(input, { target: { files: [photo(2)] } });
  fireEvent.change(input, { target: { files: [photo(3)] } });

  expect(await screen.findByText('3 photos prises')).toBeInTheDocument();
  // Le bandeau de file compte les photos encore sur le téléphone.
  expect(await screen.findByText('3 photos en cours d’envoi')).toBeInTheDocument();
  expect(enqueue).toHaveBeenCalledTimes(3);
  enqueue.mock.calls.forEach((call) => expect(call[1]).toBe('entry'));
  // Chaque photo porte le compte qui l'a prise.
  enqueue.mock.calls.forEach((call) => expect(call[2]).toBe('u1'));
  expect(kick).toHaveBeenCalledTimes(3);
  expect((await queueStats()).count).toBe(3);
  // L'envoyeur a bien été relancé, mais l'écran n'a pas attendu sa réponse.
  await waitFor(() => expect(upload).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: /Photo suivante/ })).toBeEnabled();
  expect(input).toHaveValue('');
});

it('accorde le compteur au singulier', async () => {
  vi.spyOn(api, 'uploadPhoto').mockReturnValue(new Promise(() => {}));
  mount();
  fireEvent.change(screen.getByLabelText('Prendre une photo'), { target: { files: [photo(1)] } });
  expect(await screen.findByText('1 photo prise')).toBeInTheDocument();
});

it('affiche l’erreur de file pleine et ne compte pas la photo', async () => {
  vi.spyOn(queue, 'enqueuePhoto').mockRejectedValue(new QueueFullError());
  const kick = vi.spyOn(sender, 'kickSender');
  mount();
  // La session (/auth/me) est chargée avant toute photo, comme derrière RequireAuth.
  await waitFor(() => expect(api.getMe).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.change(screen.getByLabelText('Prendre une photo'), { target: { files: [photo(1)] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('File d’envoi pleine (200 photos) — attendez que les envois partent');
  expect(screen.getByText('0 photo prise')).toBeInTheDocument();
  expect(kick).not.toHaveBeenCalled();
});

it('mène à la liste des vins à confirmer', () => {
  mount();
  expect(screen.getByRole('link', { name: /Voir les vins à confirmer/ })).toHaveAttribute('href', '/a-confirmer');
});
