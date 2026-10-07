import { act, render } from '@testing-library/react';
import { queueStats, subscribeQueueChanged } from './offline-queue';
import { sendQueuedPhotos, setSenderAccount } from './photo-sender';
import { useBackgroundSender } from './use-background-sender';

vi.mock('./offline-queue', () => ({
  queueStats: vi.fn().mockResolvedValue({ count: 0, bytes: 0, others: 0 }),
  subscribeQueueChanged: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock('./photo-sender', () => ({
  sendQueuedPhotos: vi.fn().mockResolvedValue(undefined),
  setSenderAccount: vi.fn(),
}));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function Probe({ enabled = true }: { enabled?: boolean }) {
  useBackgroundSender(enabled ? 'u1' : null);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Réinitialisés à chaque test : `restoreAllMocks` efface aussi les retours des faux du module.
  vi.mocked(sendQueuedPhotos).mockReset().mockResolvedValue(undefined);
  vi.mocked(subscribeQueueChanged).mockReset().mockReturnValue(vi.fn());
  vi.mocked(queueStats).mockReset().mockResolvedValue({ count: 0, bytes: 0, others: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('arme les déclencheurs une seule fois, même après plusieurs rendus', async () => {
  const addWindow = vi.spyOn(window, 'addEventListener');
  const addDocument = vi.spyOn(document, 'addEventListener');
  const { rerender } = render(<Probe />);
  rerender(<Probe />);
  rerender(<Probe />);
  await flush();
  expect(addWindow.mock.calls.filter(([type]) => type === 'online')).toHaveLength(1);
  expect(addDocument.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
  expect(subscribeQueueChanged).toHaveBeenCalledTimes(1);
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1); // envoi au montage
});

it('relance l’envoi au retour du réseau et quand l’application redevient visible', async () => {
  render(<Probe />);
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);

  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(2);

  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(3);
});

it('relance l’envoi toutes les 15 s tant que la file n’est pas vide, puis s’arrête', async () => {
  vi.mocked(queueStats).mockResolvedValue({ count: 2, bytes: 10, others: 0 });
  render(<Probe />);
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(15_000);
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(2);

  // La file se vide : la prochaine notification arrête la minuterie.
  vi.mocked(queueStats).mockResolvedValue({ count: 0, bytes: 0, others: 0 });
  const onChange = vi.mocked(subscribeQueueChanged).mock.calls[0][0];
  act(() => onChange());
  await flush();
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(2);
});

it('n’arme rien tant que l’utilisateur n’est pas connecté, et tout se désarme au démontage', async () => {
  const unsubscribe = vi.fn();
  vi.mocked(subscribeQueueChanged).mockReturnValue(unsubscribe);
  vi.mocked(queueStats).mockResolvedValue({ count: 2, bytes: 10, others: 0 });
  const { rerender, unmount } = render(<Probe enabled={false} />);
  await flush();
  expect(sendQueuedPhotos).not.toHaveBeenCalled();
  expect(subscribeQueueChanged).not.toHaveBeenCalled();

  rerender(<Probe enabled />);
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);

  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60_000);
  });
  await flush();
  expect(sendQueuedPhotos).toHaveBeenCalledTimes(1);
});

it('désigne le compte dont la file part, et l’efface quand l’envoi s’arrête', async () => {
  const { rerender, unmount } = render(<Probe />);
  await flush();
  expect(setSenderAccount).toHaveBeenLastCalledWith('u1');
  rerender(<Probe enabled={false} />);
  expect(setSenderAccount).toHaveBeenLastCalledWith(null);
  rerender(<Probe />);
  unmount();
  expect(setSenderAccount).toHaveBeenLastCalledWith(null);
  expect(queueStats).toHaveBeenCalledWith('u1');
});
