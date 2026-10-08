import { extractionBackoffDelay } from '../queue/extraction.queue';
import { pairingBackoffDelay, pairingJobId, schedulePairing } from './pairing.queue';

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

  it('tolère un retrait qui échoue (deux régénérations simultanées) et remet quand même en file', async () => {
    const remove = jest.fn(async () => { throw new Error('Missing key for job pairing-w1'); });
    const queue = {
      getJob: jest.fn(async () => ({ getState: async () => 'completed', remove })),
      add: jest.fn(async () => undefined),
    };
    await expect(schedulePairing(queue as any, 'w1')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith('pairing', { wineId: 'w1' }, { jobId: 'pairing-w1' });
  });
});

describe('pairingBackoffDelay', () => {
  const err = (m: string) => new Error(m);

  it('un 503 ne relance plus au bout de 30 s : au moins les 5 min de la pause', () => {
    expect(pairingBackoffDelay(1, err('[GoogleGenerativeAI Error]: … [503 Service Unavailable] busy'))).toBe(5 * 60_000);
    expect(pairingBackoffDelay(10, err('[503 Service Unavailable] busy'))).toBe(15 * 60_000);
  });

  it('un 429 : au moins l’heure de la pause', () => {
    expect(pairingBackoffDelay(1, err('[429 Too Many Requests] quota'))).toBe(60 * 60_000);
    expect(pairingBackoffDelay(10, err('[429 Too Many Requests] quota'))).toBe(60 * 60_000);
  });

  it('les autres pannes gardent la reprise habituelle', () => {
    expect(pairingBackoffDelay(1, err('fetch failed'))).toBe(extractionBackoffDelay(1));
    expect(pairingBackoffDelay(3, undefined)).toBe(extractionBackoffDelay(3));
  });
});
