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

it('sends once on mount, once per 15s tick while mounted, once on online, and never after unmount', async () => {
  const { unmount } = render(<Probe />);
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(2);

  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(3);

  unmount();
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(3);
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
