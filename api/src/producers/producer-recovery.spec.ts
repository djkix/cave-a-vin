import { requeueMissingProducers } from './producer-recovery';
import { producerJobId } from './producer.queue';

it('met en file une fois chaque domaine sans descriptif ou en attente, et eux seuls', async () => {
  const wineFindMany = jest.fn(async () => [
    { producer: 'Domaine Tempier' }, { producer: 'DOMAINE TEMPIER' }, { producer: 'Château Simone' },
    { producer: 'Clos Rougeard' }, { producer: 'Clos Rougeard ' }, { producer: ' — ' }, { producer: 'Mas Jullien' },
  ]);
  const profileFindMany = jest.fn(async () => [
    { producerKey: 'chateau simone', status: 'DONE' },
    { producerKey: 'clos rougeard', status: 'PENDING' },
    { producerKey: 'mas jullien', status: 'FAILED' },
  ]);
  const queue = { getJob: jest.fn(async () => undefined), add: jest.fn(async () => undefined) };
  const log = jest.fn();
  const n = await requeueMissingProducers({ wine: { findMany: wineFindMany }, producerProfile: { findMany: profileFindMany } } as any, queue as any, log);
  expect(n).toBe(2);
  expect(wineFindMany).toHaveBeenCalledWith({ select: { producer: true }, distinct: ['producer'] });
  expect(queue.add).toHaveBeenCalledTimes(2);
  expect(queue.add).toHaveBeenCalledWith('producer', { producerKey: 'domaine tempier' }, { jobId: producerJobId('domaine tempier') });
  expect(queue.add).toHaveBeenCalledWith('producer', { producerKey: 'clos rougeard' }, { jobId: producerJobId('clos rougeard') });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('2 domaine'));
});
