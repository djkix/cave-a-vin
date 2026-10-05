import { pairingJobId, schedulePairing } from './pairing.queue';

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

describe('schedulePairing', () => {
  it('met le vin en file sous un identifiant unique', async () => {
    const { queue } = fakeQueue();
    await schedulePairing(queue as any, 'w1');
    expect(queue.add).toHaveBeenCalledWith('pairing', { wineId: 'w1' }, { jobId: pairingJobId('w1') });
    expect(pairingJobId('w1')).toBe('pairing-w1');
  });

  it('ne double pas un travail encore vivant', async () => {
    const { queue } = fakeQueue({ state: 'delayed' });
    await schedulePairing(queue as any, 'w1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'])('relance un travail %s en le retirant d’abord (régénération)', async (state) => {
    const { queue, remove } = fakeQueue({ state });
    await schedulePairing(queue as any, 'w1');
    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
