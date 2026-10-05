import { requeueMissingPairings } from './pairing-recovery';

it('met en file les vins sans accords ou en attente, et eux seuls', async () => {
  const findMany = jest.fn(async () => [{ id: 'w1' }, { id: 'w2' }]);
  const queue = { getJob: jest.fn(async () => undefined), add: jest.fn(async () => undefined) };
  const n = await requeueMissingPairings({ wine: { findMany } } as any, queue as any);
  expect(n).toBe(2);
  expect(findMany).toHaveBeenCalledWith({
    where: { OR: [{ pairing: null }, { pairing: { status: 'PENDING' } }] },
    select: { id: true },
  });
  expect(queue.add).toHaveBeenCalledWith('pairing', { wineId: 'w2' }, { jobId: 'pairing-w2' });
});
