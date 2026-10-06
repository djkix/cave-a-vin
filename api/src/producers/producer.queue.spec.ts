import { producerJobId, scheduleProducer } from './producer.queue';

function fakeQueue(existing?: { state: string }) {
  const remove = jest.fn(async () => undefined);
  return {
    remove,
    queue: {
      getJob: jest.fn(async () => (existing ? { getState: async () => existing.state, remove } : undefined)),
      add: jest.fn(async () => undefined),
    },
  };
}

describe('scheduleProducer', () => {
  it('met le domaine en file dans la file des accords, sous le nom « producer »', async () => {
    const { queue } = fakeQueue();
    await scheduleProducer(queue as any, 'domaine tempier');
    expect(queue.getJob).toHaveBeenCalledWith(producerJobId('domaine tempier'));
    expect(queue.add).toHaveBeenCalledWith('producer', { producerKey: 'domaine tempier' }, { jobId: producerJobId('domaine tempier') });
  });

  it('ne double pas un travail encore vivant', async () => {
    const { queue } = fakeQueue({ state: 'waiting' });
    await scheduleProducer(queue as any, 'domaine tempier');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'])('relance un travail %s en le retirant d’abord (régénération)', async (state) => {
    const { queue, remove } = fakeQueue({ state });
    await scheduleProducer(queue as any, 'domaine tempier');
    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
