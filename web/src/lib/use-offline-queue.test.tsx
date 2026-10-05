import { act, render } from '@testing-library/react';
import { queueStats, subscribeQueueChanged } from './offline-queue';
import { sendQueuedPhotos } from './photo-sender';
import { useOfflineQueue } from './use-offline-queue';

vi.mock('./offline-queue', () => ({
  queueStats: vi.fn().mockResolvedValue({ count: 0, bytes: 0 }),
  notifyQueueChanged: vi.fn(),
  subscribeQueueChanged: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock('./photo-sender', () => ({
  sendQueuedPhotos: vi.fn().mockResolvedValue(undefined),
}));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

function Probe() {
  useOfflineQueue();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sendQueuedPhotos).mockClear();
  vi.mocked(subscribeQueueChanged).mockClear();
  vi.mocked(queueStats).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

it('ne fait que lire la file : aucun envoi au montage, ni par minuterie, ni au retour du réseau', async () => {
  const { unmount } = render(<Probe />);
  await flush();
  act(() => {
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event('online'));
  });
  await flush();
  expect(sendQueuedPhotos).not.toHaveBeenCalled();
  expect(queueStats).toHaveBeenCalled();
  unmount();
});

it('flushNow envoie la file à la demande', async () => {
  let api: ReturnType<typeof useOfflineQueue> | undefined;
  function Capture() {
    api = useOfflineQueue();
    return null;
  }
  render(<Capture />);
  await flush();
  await act(async () => {
    await api!.flushNow();
  });
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);
});

it('subscribes to queue changes to refresh stats, and unsubscribes on unmount', async () => {
  const unsubscribe = vi.fn();
  vi.mocked(subscribeQueueChanged).mockReturnValue(unsubscribe);

  const { unmount } = render(<Probe />);
  await flush();
  expect(subscribeQueueChanged).toHaveBeenCalledTimes(1);
  expect(unsubscribe).not.toHaveBeenCalled();

  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
