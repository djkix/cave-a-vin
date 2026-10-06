import { raceScheduleWithTimeout } from './pairing.queue';

describe('raceScheduleWithTimeout', () => {
  afterEach(() => jest.useRealTimers());

  it('rend la main dès que la planification aboutit, sans prévenir', async () => {
    jest.useFakeTimers();
    const onTimeout = jest.fn();
    await raceScheduleWithTimeout(Promise.resolve(), 3000, onTimeout);
    await jest.advanceTimersByTimeAsync(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rend la main au bout du délai si la planification ne répond pas, en prévenant', async () => {
    jest.useFakeTimers();
    const onTimeout = jest.fn();
    let settled = false;
    const p = raceScheduleWithTimeout(new Promise<void>(() => undefined), 3000, onTimeout).then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('propage l’échec de la planification', async () => {
    await expect(raceScheduleWithTimeout(Promise.reject(new Error('Redis')), 3000, () => undefined)).rejects.toThrow('Redis');
  });
});
