import { NotFoundException } from '@nestjs/common';
import { PairingService } from './pairing.service';

function harness(opts: { wine?: unknown; schedule?: () => Promise<void> } = {}) {
  const upsert = jest.fn(async () => ({}));
  const prisma = {
    wine: { findUnique: jest.fn(async () => ('wine' in opts ? opts.wine : { id: 'w1' })) },
    pairing: { upsert },
  };
  const scheduler = { schedule: jest.fn(opts.schedule ?? (async () => {})) };
  return { upsert, scheduler, service: new PairingService(prisma as any, scheduler as any) };
}

describe('PairingService.regenerate', () => {
  it('remet l’accord en attente et planifie sa régénération', async () => {
    const h = harness();
    await h.service.regenerate('w1');
    expect(h.upsert).toHaveBeenCalledWith({ where: { wineId: 'w1' }, create: { wineId: 'w1' }, update: { status: 'PENDING', errorMessage: null } });
    expect(h.scheduler.schedule).toHaveBeenCalledWith('w1');
  });

  it('refuse un vin introuvable', async () => {
    const h = harness({ wine: null });
    await expect(h.service.regenerate('w1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('n’attend pas indéfiniment une planification qui ne répond pas (Redis indisponible) : la ligne PENDING et la reprise du worker prendront le relais', async () => {
    jest.useFakeTimers();
    try {
      let resolveSchedule!: () => void;
      const neverSettling = new Promise<void>((resolve) => { resolveSchedule = resolve; });
      const h = harness({ schedule: () => neverSettling });

      const warn = jest.spyOn((h.service as any).logger, 'warn').mockImplementation(() => undefined);

      const regenerate = h.service.regenerate('w1');
      let settled = false;
      regenerate.then(() => { settled = true; });

      await jest.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await regenerate;
      expect(settled).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('w1'));

      resolveSchedule();
    } finally {
      jest.useRealTimers();
    }
  });
});
