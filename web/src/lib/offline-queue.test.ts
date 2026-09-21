import { enqueuePhoto, flushQueue, listQueue, queueStats, QueueFullError, _resetForTests } from './offline-queue';

const blob = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

beforeEach(() => _resetForTests());

it('stores photos and reports stats', async () => {
  await enqueuePhoto(blob(10), 'single');
  await enqueuePhoto(blob(20), 'campaign');
  expect(await queueStats()).toEqual({ count: 2, bytes: 30 });
  expect((await listQueue()).map((p) => p.mode)).toEqual(['single', 'campaign']);
});

it('refuses beyond 20 items or 50 MB', async () => {
  for (let i = 0; i < 20; i++) await enqueuePhoto(blob(1), 'single');
  await expect(enqueuePhoto(blob(1), 'single')).rejects.toBeInstanceOf(QueueFullError);
  await _resetForTests();
  await expect(enqueuePhoto(blob(50 * 1024 * 1024 + 1), 'single')).rejects.toBeInstanceOf(QueueFullError);
});

it('flushes in order, removes sent items and stops at the first failure', async () => {
  await enqueuePhoto(blob(1), 'single');
  await enqueuePhoto(blob(2), 'single');
  await enqueuePhoto(blob(3), 'single');
  const upload = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({});
  const r = await flushQueue(upload);
  expect(r).toEqual({ sent: 1, failed: 1 });
  expect((await queueStats()).count).toBe(2);
});
