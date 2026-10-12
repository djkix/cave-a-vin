import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProducersController } from './producers.controller';
import { ProducerScheduler, ProducersService } from './producers.service';

const KEY = 'domaine tempier';
const wines = [{ producer: 'Domaine Tempier', appellationRaw: 'Bandol', appellation: null }];
const include = { updatedBy: { select: { displayName: true, email: true } } };

const conflict = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });

function harness(opts: { wines?: unknown[]; saved?: unknown; existing?: unknown; conflictOnce?: boolean } = {}) {
  let conflicts = opts.conflictOnce ? 1 : 0;
  const upsert = jest.fn(async () => {
    if (conflicts-- > 0) throw conflict();
    return opts.saved ?? {
      producerKey: KEY, displayName: 'Domaine Tempier', status: 'DONE', description: 'Texte', source: 'MANUEL',
      errorMessage: null, generatedAt: null, updatedBy: { displayName: null, email: 'franck@example.com' },
    };
  });
  const findUnique = jest.fn(async () => opts.existing ?? null);
  const prisma = { wine: { findMany: jest.fn(async () => opts.wines ?? wines) }, producerProfile: { upsert, findUnique } };
  return { upsert, service: new ProducersService(prisma as any) };
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
  });

  it('réessaie une fois quand une création concurrente (worker) gagne la course (P2002)', async () => {
    const h = harness({ conflictOnce: true });
    await expect(h.service.setDescription(KEY, 'Texte', 'u1')).resolves.toMatchObject({ source: 'MANUEL' });
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it('refuse un domaine qu’aucun vin ne porte', async () => {
    const h = harness({ wines: [] });
    await expect(h.service.setDescription(KEY, 'Texte', 'u1')).rejects.toThrow(new NotFoundException('Domaine introuvable'));
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('ProducersService.regenerate', () => {
  it('depuis un texte manuel : repasse côté Gemini, en attente, sans le texte ni son auteur', async () => {
    const h = harness({ existing: { source: 'MANUEL' } });
    await h.service.regenerate(KEY);
    expect(h.upsert).toHaveBeenCalledWith({
      where: { producerKey: KEY },
      create: { producerKey: KEY, displayName: 'Domaine Tempier', requestedAt: expect.any(Date) },
      update: { status: 'PENDING', source: 'GEMINI', errorMessage: null, requestedAt: expect.any(Date), attempts: 0, nextAttemptAt: null, description: null, updatedById: null },
    });
  });

  it('depuis un texte Gemini : garde le texte visible pendant la nouvelle génération (comme les accords)', async () => {
    const h = harness({ existing: { source: 'GEMINI' } });
    await h.service.regenerate(KEY);
    expect(h.upsert).toHaveBeenCalledWith({
      where: { producerKey: KEY },
      create: { producerKey: KEY, displayName: 'Domaine Tempier', requestedAt: expect.any(Date) },
      update: { status: 'PENDING', source: 'GEMINI', errorMessage: null, requestedAt: expect.any(Date), attempts: 0, nextAttemptAt: null },
    });
  });

  it('sans profil : le crée en attente, et réessaie une fois sur une création concurrente (P2002)', async () => {
    const h = harness({ conflictOnce: true });
    await h.service.regenerate(KEY);
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it('refuse un domaine qu’aucun vin ne porte', async () => {
    const h = harness({ wines: [{ producer: 'Château Simone' }] });
    await expect(h.service.regenerate(KEY)).rejects.toThrow(new NotFoundException('Domaine introuvable'));
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('ne dépend que de la base : la régénération ne peut jamais appeler Gemini ni une file', () => {
    expect(ProducersService.length).toBe(1);
  });
});

describe('ProducerScheduler.scheduleIfMissing', () => {
  function scheduler(profile: unknown) {
    const findUnique = jest.fn(async () => profile);
    const createMany = jest.fn(async () => ({ count: 1 }));
    return { findUnique, createMany, s: new ProducerScheduler({ producerProfile: { findUnique, createMany } } as any) };
  }

  it('crée en attente le descriptif d’un domaine qui n’en a pas, sous sa clé normalisée', async () => {
    const h = scheduler(null);
    await h.s.scheduleIfMissing('DOMAINE TEMPIER');
    expect(h.findUnique).toHaveBeenCalledWith({ where: { producerKey: KEY }, select: { id: true } });
    expect(h.createMany).toHaveBeenCalledWith({ data: [{ producerKey: KEY, displayName: 'DOMAINE TEMPIER', requestedAt: expect.any(Date) }], skipDuplicates: true });
  });

  it('ne fait rien pour un domaine qui a déjà un descriptif', async () => {
    const h = scheduler({ id: 'p1' });
    await h.s.scheduleIfMissing('Domaine Tempier');
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it('ne fait rien pour un nom de domaine sans lettre ni chiffre', async () => {
    const h = scheduler(null);
    await h.s.scheduleIfMissing(' — ');
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(h.createMany).not.toHaveBeenCalled();
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
