import { requeueMissingPairings } from './pairing-recovery';

it('crée en attente la demande d’accords des vins qui n’en ont pas, et d’eux seuls', async () => {
  const findMany = jest.fn(async () => [{ id: 'w1' }, { id: 'w2' }]);
  const createMany = jest.fn(async () => ({ count: 2 }));
  const log = jest.fn();
  const n = await requeueMissingPairings({ wine: { findMany }, pairing: { createMany } } as any, log);
  expect(n).toBe(2);
  expect(findMany).toHaveBeenCalledWith({ where: { pairing: null }, select: { id: true } });
  expect(createMany).toHaveBeenCalledWith({
    data: [{ wineId: 'w1', requestedAt: expect.any(Date) }, { wineId: 'w2', requestedAt: expect.any(Date) }],
    skipDuplicates: true,
  });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('2 vin'));
});

it('ne fait rien quand tous les vins ont leur demande (les demandes en attente restent dans la file)', async () => {
  const createMany = jest.fn();
  expect(await requeueMissingPairings({ wine: { findMany: async () => [] }, pairing: { createMany } } as any)).toBe(0);
  expect(createMany).not.toHaveBeenCalled();
});
