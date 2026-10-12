import { requeueMissingProducers } from './producer-recovery';

it('crée en attente, une seule fois, le descriptif de chaque domaine qui n’en a pas, sous la graphie la plus ancienne', async () => {
  const wineFindMany = jest.fn(async () => [
    { producer: 'Domaine Tempier' }, { producer: 'DOMAINE TEMPIER' }, { producer: 'Château Simone' },
    { producer: 'Clos Rougeard' }, { producer: ' — ' }, { producer: 'Mas Jullien' },
  ]);
  const profileFindMany = jest.fn(async () => [
    { producerKey: 'chateau simone' },
    { producerKey: 'clos rougeard' },
  ]);
  const createMany = jest.fn(async () => ({ count: 2 }));
  const log = jest.fn();
  const n = await requeueMissingProducers({ wine: { findMany: wineFindMany }, producerProfile: { findMany: profileFindMany, createMany } } as any, log);
  expect(n).toBe(2);
  expect(wineFindMany).toHaveBeenCalledWith({ select: { producer: true }, orderBy: { createdAt: 'asc' } });
  expect(createMany).toHaveBeenCalledWith({
    data: [
      { producerKey: 'domaine tempier', displayName: 'Domaine Tempier', requestedAt: expect.any(Date) },
      { producerKey: 'mas jullien', displayName: 'Mas Jullien', requestedAt: expect.any(Date) },
    ],
    skipDuplicates: true,
  });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('2 domaine'));
});
