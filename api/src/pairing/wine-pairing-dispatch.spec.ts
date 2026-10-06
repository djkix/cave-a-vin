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
