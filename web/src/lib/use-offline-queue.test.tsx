import { act, render } from '@testing-library/react';
import { flushQueue } from './offline-queue';
import { useOfflineQueue } from './use-offline-queue';

vi.mock('./offline-queue', () => ({
  flushQueue: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  queueStats: vi.fn().mockResolvedValue({ count: 0, bytes: 0 }),
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
  vi.mocked(flushQueue).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

it('flushes once on mount, once per 60s tick while mounted, once on online, and never after unmount', async () => {
  const { unmount } = render(<Probe />);
  await flush();
  expect(flushQueue).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(30_000);
  });
  await flush();
  expect(flushQueue).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(30_000);
  });
  await flush();
  expect(flushQueue).toHaveBeenCalledTimes(2);

  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await flush();
  expect(flushQueue).toHaveBeenCalledTimes(3);

  unmount();
  act(() => {
    vi.advanceTimersByTime(120_000);
  });
  await flush();
  expect(flushQueue).toHaveBeenCalledTimes(3);
});
