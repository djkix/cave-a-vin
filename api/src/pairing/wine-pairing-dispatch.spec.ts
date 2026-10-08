import { DelayedError } from 'bullmq';
import { GeminiPausedError } from '../vision/gemini-pause';
import { processWinePairingJob } from './wine-pairing-dispatch';

function processors() {
  return { pairing: { process: jest.fn(async () => undefined) }, producer: { process: jest.fn(async () => undefined) } };
}

describe('processWinePairingJob', () => {
  it('confie un travail « pairing » aux accords, avec l’indication du dernier essai', async () => {
    const p = processors();
    await processWinePairingJob({ name: 'pairing', data: { wineId: 'w1' }, attemptsMade: 0, opts: { attempts: 3 } } as any, p);
    expect(p.pairing.process).toHaveBeenCalledWith('w1', false);
    expect(p.producer.process).not.toHaveBeenCalled();
  });

  it('confie un travail « producer » au descriptif du domaine', async () => {
    const p = processors();
    await processWinePairingJob({ name: 'producer', data: { producerKey: 'domaine tempier' }, attemptsMade: 2, opts: { attempts: 3 } } as any, p);
    expect(p.producer.process).toHaveBeenCalledWith('domaine tempier', true);
    expect(p.pairing.process).not.toHaveBeenCalled();
  });
});

describe('processWinePairingJob — pause commune de Gemini', () => {
  const until = new Date('2026-10-08T12:05:00.000Z');

  it.each(['pairing', 'producer'])('travail « %s » en pause : reporté après la pause (+ quelques secondes), sans tentative consommée', async (name) => {
    const p = processors();
    const proc = name === 'pairing' ? p.pairing : p.producer;
    proc.process.mockRejectedValueOnce(new GeminiPausedError(until, 'quota épuisé'));
    const job = { name, data: { wineId: 'w1', producerKey: 'k' }, attemptsMade: 999, opts: { attempts: 1000 }, moveToDelayed: jest.fn(async () => undefined) };
    await expect(processWinePairingJob(job as any, p, 'jeton')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = job.moveToDelayed.mock.calls[0] as unknown as [number, string];
    expect(token).toBe('jeton');
    expect(timestamp).toBeGreaterThanOrEqual(until.getTime());
    expect(timestamp).toBeLessThanOrEqual(until.getTime() + 5000);
  });

  it('une autre erreur remonte telle quelle (reprise BullMQ habituelle)', async () => {
    const p = processors();
    const boom = new Error('[503 Service Unavailable] busy');
    p.pairing.process.mockRejectedValueOnce(boom);
    const job = { name: 'pairing', data: { wineId: 'w1' }, attemptsMade: 0, opts: { attempts: 3 }, moveToDelayed: jest.fn() };
    await expect(processWinePairingJob(job as any, p, 'jeton')).rejects.toBe(boom);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
