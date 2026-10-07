import { flushQueue, notifyQueueChanged } from './offline-queue';
import { kickSender, sendQueuedPhotos, setSenderAccount, _resetSenderForTests } from './photo-sender';
import { uploadPhoto } from './api-client';

vi.mock('./offline-queue', () => ({
  flushQueue: vi.fn(),
  notifyQueueChanged: vi.fn(),
}));
vi.mock('./api-client', () => ({ uploadPhoto: vi.fn() }));

beforeEach(() => {
  _resetSenderForTests();
  setSenderAccount('u1');
  vi.mocked(flushQueue).mockClear();
  vi.mocked(notifyQueueChanged).mockClear();
});

it('sends with a single flight: two concurrent calls share one flushQueue run', async () => {
  let resolveFlush!: (v: { sent: number; failed: number }) => void;
  vi.mocked(flushQueue).mockReturnValue(new Promise((resolve) => { resolveFlush = resolve; }));

  const a = sendQueuedPhotos();
  const b = sendQueuedPhotos();
  expect(a).toBe(b);
  expect(flushQueue).toHaveBeenCalledTimes(1);
  expect(flushQueue).toHaveBeenCalledWith(uploadPhoto, 'u1');

  resolveFlush({ sent: 1, failed: 0 });
  await a;
  await b;
  expect(notifyQueueChanged).toHaveBeenCalledTimes(1);
});

it('allows a new flush after the previous one settles', async () => {
  vi.mocked(flushQueue).mockResolvedValue({ sent: 0, failed: 0 });

  await sendQueuedPhotos();
  await sendQueuedPhotos();

  expect(flushQueue).toHaveBeenCalledTimes(2);
  expect(notifyQueueChanged).toHaveBeenCalledTimes(2);
});

it('notifies listeners even when flushQueue rejects, and frees the flight for the next call', async () => {
  vi.mocked(flushQueue).mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ sent: 0, failed: 0 });

  await expect(sendQueuedPhotos()).rejects.toThrow('boom');
  expect(notifyQueueChanged).toHaveBeenCalledTimes(1);

  await sendQueuedPhotos();
  expect(flushQueue).toHaveBeenCalledTimes(2);
});

it('kickSender fires sendQueuedPhotos without waiting for it', () => {
  vi.mocked(flushQueue).mockResolvedValue({ sent: 0, failed: 0 });
  kickSender();
  expect(flushQueue).toHaveBeenCalledTimes(1);
});

it('n’envoie rien sans compte propriétaire', async () => {
  setSenderAccount(null);
  await sendQueuedPhotos();
  kickSender();
  expect(flushQueue).not.toHaveBeenCalled();
});
