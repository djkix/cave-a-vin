import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
