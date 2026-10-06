import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProducersController } from './producers.controller';
import { ProducerScheduler, ProducersService } from './producers.service';

const KEY = 'domaine tempier';
const wines = [{ producer: 'Domaine Tempier', appellationRaw: 'Bandol', appellation: null }];
const include = { updatedBy: { select: { displayName: true, email: true } } };

function harness(opts: { wines?: unknown[]; schedule?: () => Promise<void>; saved?: unknown } = {}) {
  const upsert = jest.fn(async () => opts.saved ?? {
    producerKey: KEY, displayName: 'Domaine Tempier', status: 'DONE', description: 'Texte', source: 'MANUEL',
    errorMessage: null, generatedAt: null, updatedBy: { displayName: null, email: 'franck@example.com' },
  });
  const prisma = { wine: { findMany: jest.fn(async () => opts.wines ?? wines) }, producerProfile: { upsert } };
  const scheduler = { schedule: jest.fn(opts.schedule ?? (async () => {})) };
  return { upsert, scheduler, service: new ProducersService(prisma as any, scheduler as any) };
}

describe('ProducersService.setDescription', () => {
  it('enregistre un texte saisi : DONE, MANUEL, signé du compte', async () => {
    const h = harness();
    const view = await h.service.setDescription(KEY, 'Texte', 'u1');
    const manual = { status: 'DONE', source: 'MANUEL', description: 'Texte', errorMessage: null, updatedById: 'u1' };
    expect(h.upsert).toHaveBeenCalledWith({
      where: { producerKey: KEY },
      create: { producerKey: KEY, displayName: 'Domaine Tempier', ...manual },
      update: manual,
      include,
    });
    expect(view).toEqual({
      key: KEY, displayName: 'Domaine Tempier', status: 'DONE', description: 'Texte', source: 'MANUEL',
      errorMessage: null, generatedAt: null, updatedBy: 'franck@example.com',
    });
    expect(h.scheduler.schedule).not.toHaveBeenCalled();
  });

  it('refuse un domaine qu’aucun vin ne porte', async () => {
    const h = harness({ wines: [] });
    await expect(h.service.setDescription(KEY, 'Texte', 'u1')).rejects.toThrow(new NotFoundException('Domaine introuvable'));
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('ProducersService.regenerate', () => {
  it('repasse en attente, côté Gemini (y compris depuis un texte manuel), et planifie la génération', async () => {
    const h = harness();
    await h.service.regenerate(KEY);
    expect(h.upsert).toHaveBeenCalledWith({
      where: { producerKey: KEY },
      create: { producerKey: KEY, displayName: 'Domaine Tempier' },
      update: { status: 'PENDING', source: 'GEMINI', description: null, errorMessage: null, updatedById: null },
    });
    expect(h.scheduler.schedule).toHaveBeenCalledWith(KEY);
  });

  it('refuse un domaine qu’aucun vin ne porte', async () => {
    const h = harness({ wines: [{ producer: 'Château Simone' }] });
    await expect(h.service.regenerate(KEY)).rejects.toThrow(new NotFoundException('Domaine introuvable'));
    expect(h.scheduler.schedule).not.toHaveBeenCalled();
  });

  it('n’attend pas indéfiniment une planification qui ne répond pas (Redis indisponible)', async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ schedule: () => new Promise<void>(() => undefined) });
      jest.spyOn((h.service as any).logger, 'warn').mockImplementation(() => undefined);
      let settled = false;
      const p = h.service.regenerate(KEY).then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ProducerScheduler.scheduleIfMissing', () => {
  function scheduler(profile: unknown) {
    const queue = { getJob: jest.fn(async () => undefined), add: jest.fn(async () => undefined) };
    const findUnique = jest.fn(async () => profile);
    return { queue, findUnique, s: new ProducerScheduler(queue as any, { producerProfile: { findUnique } } as any) };
  }

  it('met en file un domaine sans descriptif, sous sa clé normalisée', async () => {
    const h = scheduler(null);
    await h.s.scheduleIfMissing('DOMAINE TEMPIER');
    expect(h.findUnique).toHaveBeenCalledWith({ where: { producerKey: KEY }, select: { id: true } });
    expect(h.queue.add).toHaveBeenCalledWith('producer', { producerKey: KEY }, expect.anything());
  });

  it('ne fait rien pour un domaine qui a déjà un descriptif', async () => {
    const h = scheduler({ id: 'p1' });
    await h.s.scheduleIfMissing('Domaine Tempier');
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('ne fait rien pour un nom de domaine sans lettre ni chiffre', async () => {
    const h = scheduler(null);
    await h.s.scheduleIfMissing(' — ');
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('ProducersController', () => {
  const user = { id: 'u1' } as any;

  it('refuse un descriptif hors limites avec le message en français', async () => {
    const service = { setDescription: jest.fn() };
    const c = new ProducersController(service as any);
    expect(() => c.setDescription(KEY, { description: '  ' }, user)).toThrow(new BadRequestException('Le descriptif doit faire entre 1 et 2000 caractères'));
    expect(() => c.setDescription(KEY, { description: 'x'.repeat(2001) }, user)).toThrow(BadRequestException);
    expect(service.setDescription).not.toHaveBeenCalled();
  });

  it('transmet le texte rogné et le compte', async () => {
    const service = { setDescription: jest.fn(async () => ({})) };
    await new ProducersController(service as any).setDescription(KEY, { description: ' Texte ' }, user);
    expect(service.setDescription).toHaveBeenCalledWith(KEY, 'Texte', 'u1');
  });

  it('répond 202 à une régénération', () => {
    expect(Reflect.getMetadata('__httpCode__', ProducersController.prototype.regenerate)).toBe(202);
  });
});
