import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { _resetForTests, queueStats } from '../lib/offline-queue';
import { EntreeCapturePage } from './EntreeCapturePage';

beforeEach(() => _resetForTests());

afterEach(() => {
  vi.restoreAllMocks();
});

it('queues the photo and shows the French status when offline', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

  render(
    <MemoryRouter>
      <EntreeCapturePage />
    </MemoryRouter>,
  );

  const input = screen.getByLabelText('Prendre une photo');
  expect(input).toHaveAttribute('accept', 'image/*');
  expect(input).toHaveAttribute('capture', 'environment');

  const file = new File([new Uint8Array(10)], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });

  expect(await screen.findByText(/Photo mise en attente/)).toBeInTheDocument();
  expect(await queueStats()).toEqual({ count: 1, bytes: 10 });
});

it('queues the photo when the api answers 503 although the phone is online', async () => {
  // `enqueueWithTimeout` renvoie un 503 exprès quand Redis est injoignable : la photo
  // doit rester sur le téléphone et repartir plus tard, pas être perdue.
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new api.ApiError(503, 'File de traitement indisponible'));

  render(
    <MemoryRouter>
      <EntreeCapturePage />
    </MemoryRouter>,
  );

  const file = new File([new Uint8Array(10)], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(screen.getByLabelText('Prendre une photo'), { target: { files: [file] } });

  expect(await screen.findByText(/Photo mise en attente/)).toBeInTheDocument();
  expect((await queueStats()).count).toBe(1);
});
