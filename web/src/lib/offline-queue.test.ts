import { ApiError } from './api-client';
import {
  enqueuePhoto,
  flushQueue,
  listQueue,
  notifyQueueChanged,
  queueStats,
  QUEUE_LIMITS,
  QueueFullError,
  subscribeQueueChanged,
  _resetForTests,
} from './offline-queue';

const blob = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

beforeEach(() => _resetForTests());

it('stores photos and reports stats', async () => {
  await enqueuePhoto(blob(10), 'single');
  await enqueuePhoto(blob(20), 'campaign');
  await enqueuePhoto(blob(5), 'entry');
  expect(await queueStats()).toEqual({ count: 3, bytes: 35, others: 0 });
  expect((await listQueue()).map((p) => p.mode).sort()).toEqual(['campaign', 'entry', 'single']);
});

it('refuses beyond 200 items or 200 Mo with a French message', async () => {
  expect(QUEUE_LIMITS).toEqual({ maxItems: 200, maxBytes: 200 * 1024 * 1024 });
  for (let i = 0; i < 200; i++) await enqueuePhoto(blob(1), 'entry');
  await expect(enqueuePhoto(blob(1), 'entry')).rejects.toBeInstanceOf(QueueFullError);
  await expect(enqueuePhoto(blob(1), 'entry')).rejects.toThrow(
    'File d’envoi pleine (200 photos) — attendez que les envois partent',
  );
  await _resetForTests();
  await expect(enqueuePhoto(blob(200 * 1024 * 1024 + 1), 'entry')).rejects.toBeInstanceOf(QueueFullError);
  await expect(enqueuePhoto(blob(200 * 1024 * 1024 + 1), 'entry')).rejects.toThrow(
    'File d’envoi pleine (200 photos) — attendez que les envois partent',
  );
});

it('notifies subscribers when the queue changes', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeQueueChanged(listener);
  notifyQueueChanged();
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  notifyQueueChanged();
  expect(listener).toHaveBeenCalledTimes(1);
});

it('flushes in order, removes sent items and stops at the first failure', async () => {
  await enqueuePhoto(blob(1), 'single');
  await enqueuePhoto(blob(2), 'single');
  await enqueuePhoto(blob(3), 'single');
  const upload = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({});
  const r = await flushQueue(upload, 'u1');
  expect(r).toEqual({ sent: 1, failed: 1 });
  expect((await queueStats()).count).toBe(2);
});

it('skips a photo the server deterministically rejects and continues with the rest', async () => {
  await enqueuePhoto(blob(1), 'single');
  await enqueuePhoto(blob(2), 'single');
  await enqueuePhoto(blob(3), 'single');
  const upload = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ApiError(400, 'Format d’image non pris en charge'))
    .mockResolvedValue({});
  const r = await flushQueue(upload, 'u1');
  expect(r).toEqual({ sent: 2, failed: 1 });
  expect((await queueStats()).count).toBe(0);
});

it('keeps the item when the server rate-limits the flush', async () => {
  await enqueuePhoto(blob(1), 'single');
  await enqueuePhoto(blob(2), 'single');
  await enqueuePhoto(blob(3), 'single');
  const upload = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ApiError(429, 'Trop de requêtes'))
    .mockResolvedValue({});
  const r = await flushQueue(upload, 'u1');
  expect(r).toEqual({ sent: 1, failed: 1 });
  expect((await queueStats()).count).toBe(2);
});

it('stops and keeps the item on a session error', async () => {
  await enqueuePhoto(blob(1), 'single');
  await enqueuePhoto(blob(2), 'single');
  await enqueuePhoto(blob(3), 'single');
  const upload = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ApiError(401, 'Connexion requise'))
    .mockResolvedValue({});
  const r = await flushQueue(upload, 'u1');
  expect(r).toEqual({ sent: 1, failed: 1 });
  expect((await queueStats()).count).toBe(2);
});

describe('file rattachée au compte', () => {
  it('estampille la photo du compte qui l’a prise', async () => {
    await enqueuePhoto(blob(1), 'entry', 'u1');
    expect((await listQueue())[0].userId).toBe('u1');
  });

  it('n’envoie ni ne retire une photo d’un autre compte, et envoie les siennes', async () => {
    await enqueuePhoto(blob(1), 'entry', 'u2');
    await enqueuePhoto(blob(2), 'entry', 'u1');
    const upload = vi.fn().mockResolvedValue({});
    expect(await flushQueue(upload, 'u1')).toEqual({ sent: 1, failed: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    const left = await listQueue();
    expect(left).toHaveLength(1);
    expect(left[0].userId).toBe('u2');
  });

  it('n’efface pas non plus la photo d’un autre compte refusée d’office', async () => {
    await enqueuePhoto(blob(1), 'entry', 'u2');
    const upload = vi.fn().mockRejectedValue(new ApiError(400, 'Format'));
    expect(await flushQueue(upload, 'u1')).toEqual({ sent: 0, failed: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect((await listQueue())).toHaveLength(1);
  });

  it('envoie une photo ancienne, sans estampille, avec le premier compte qui vide la file', async () => {
    await enqueuePhoto(blob(1), 'entry');
    const upload = vi.fn().mockResolvedValue({});
    expect(await flushQueue(upload, 'u1')).toEqual({ sent: 1, failed: 0 });
    expect(await listQueue()).toHaveLength(0);
  });

  it('compte à part les photos d’un autre compte', async () => {
    await enqueuePhoto(blob(1), 'entry', 'u1');
    await enqueuePhoto(blob(2), 'entry');
    await enqueuePhoto(blob(4), 'entry', 'u2');
    expect(await queueStats('u1')).toEqual({ count: 2, bytes: 3, others: 1 });
    expect(await queueStats('u2')).toEqual({ count: 2, bytes: 6, others: 1 });
  });

  it('applique les limites à toute la file, tous comptes confondus', async () => {
    for (let i = 0; i < 200; i++) await enqueuePhoto(blob(1), 'entry', 'u2');
    await expect(enqueuePhoto(blob(1), 'entry', 'u1')).rejects.toBeInstanceOf(QueueFullError);
  });
});
