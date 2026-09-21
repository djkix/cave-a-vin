import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MovementsService } from './movements.service';

function harness() {
  const movements: any[] = [];
  const wine = { id: 'w1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
  const stock = () => movements.filter((m) => m.wineId === 'w1').reduce((s, m) => s + m.delta, 0);
  const prisma = {
    movement: {
      findUnique: async ({ where, include }: any) => {
        const m = movements.find((x) => x.idempotencyKey === where.idempotencyKey || x.id === where.id) ?? null;
        return m && include?.wine ? { ...m, wine } : m;
      },
      create: async ({ data, include }: any) => {
        if (stock() + data.delta < 0) throw new Error('il ne reste aucune bouteille de ce vin');
        const m = { id: `m${movements.length + 1}`, occurredAt: new Date(), ...data };
        movements.push(m);
        return include?.wine ? { ...m, wine } : m;
      },
      findMany: async ({ take }: any) => [...movements].reverse().slice(0, take).map((m) => ({ ...m, wine })),
      findFirst: async ({ where }: any) => movements.find((m) => m.reversesId === where.reversesId) ?? null,
    },
    $queryRaw: async () => [{ quantity: stock() }],
  };
  const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
  return { movements, service: new MovementsService(prisma as any, matching as any) };
}

const input = {
  idempotencyKey: 'k1',
  wine: { producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75, vintage: 2019 },
  quantity: 6,
};

describe('MovementsService', () => {
  it('creates a positive IN movement and returns the new stock', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    expect(r.created).toBe(true);
    expect(r.movement.delta).toBe(6);
    expect(r.movement.type).toBe('IN');
    expect(r.stock).toBe(6);
  });

  it('is idempotent on idempotencyKey', async () => {
    const h = harness();
    await h.service.createIn(input);
    const again = await h.service.createIn({ ...input, quantity: 99 });
    expect(again.created).toBe(false);
    expect(h.movements).toHaveLength(1);
    expect((again.movement as unknown as { wine?: unknown }).wine).toBeUndefined();
  });

  it('is idempotent even when a concurrent replay wins the create race on idempotencyKey', async () => {
    // findUnique's pre-check misses (no row yet), then create() loses the race to a
    // concurrent request that inserted the same idempotencyKey first: Postgres throws
    // P2002 instead of returning cleanly. The service must recover by re-reading the
    // now-visible row, not bubble up a 500.
    const wine = { id: 'w1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const racedMovement = {
      id: 'raced-1',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k1',
      reversesId: null,
    };
    let findUniqueCalls = 0;
    let createCalls = 0;
    const prisma = {
      movement: {
        findUnique: async () => {
          findUniqueCalls += 1;
          if (findUniqueCalls === 1) return null;
          return { ...racedMovement, wine };
        },
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['idempotency_key'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 6 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    const r = await service.createIn(input);
    expect(r.created).toBe(false);
    expect(r.movement.id).toBe('raced-1');
    expect(createCalls).toBe(1);
    expect(findUniqueCalls).toBe(2);
  });

  it('returns the first movement when the same photo is confirmed twice', async () => {
    // idx_movement_photo_in : une photo ne crédite le stock qu'une fois. La seconde
    // confirmation (autre téléphone, ou retour sur une fiche déjà validée) porte une
    // idempotencyKey neuve, c'est donc l'index sur photo_id qui la rattrape.
    const wine = { id: 'w1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const firstMovement = {
      id: 'm-first',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: 'ph1',
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k-first',
      reversesId: null,
    };
    let createCalls = 0;
    const findFirstArgs: any[] = [];
    const prisma = {
      movement: {
        findUnique: async () => null,
        findFirst: async (args: any) => {
          findFirstArgs.push(args);
          return { ...firstMovement, wine };
        },
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['photo_id'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 6 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    const r = await service.createIn({ ...input, idempotencyKey: 'k-second', photoId: 'ph1' });
    expect(r.created).toBe(false);
    expect(r.movement.id).toBe('m-first');
    expect(r.stock).toBe(6);
    expect(createCalls).toBe(1);
    expect(findFirstArgs[0].where).toEqual({ photoId: 'ph1', type: 'IN' });
    expect((r.movement as unknown as { wine?: unknown }).wine).toBeUndefined();
  });

  it('rejects a non-positive quantity', async () => {
    const h = harness();
    await expect(h.service.createIn({ ...input, quantity: 0 })).rejects.toThrow(/quantité/i);
  });

  it('cancels by writing the inverse movement, never deleting', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    const c = await h.service.cancel(r.movement.id, 'cancel-1');
    expect(c.movement.delta).toBe(-6);
    expect(c.movement.type).toBe('ADJUST');
    expect(c.movement.reversesId).toBe(r.movement.id);
    expect(c.stock).toBe(0);
    expect(h.movements).toHaveLength(2);
  });

  it('refuses to cancel twice', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    await h.service.cancel(r.movement.id, 'cancel-1');
    await expect(h.service.cancel(r.movement.id, 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to cancel a cancellation', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    const c = await h.service.cancel(r.movement.id, 'cancel-1');
    await expect(h.service.cancel(c.movement.id, 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.cancel(c.movement.id, 'cancel-3')).rejects.toThrow(/annulation ne peut pas être annulée/i);
  });

  it('is idempotent on cancel even when a concurrent replay wins the create race on idempotencyKey', async () => {
    const wine = { id: 'w1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const original = {
      id: 'm1',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k1',
      reversesId: null,
    };
    const racedReversal = {
      id: 'raced-2',
      wineId: 'w1',
      delta: -6,
      type: 'ADJUST',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: 'Annulation du mouvement m1',
      idempotencyKey: 'cancel-1',
      reversesId: 'm1',
    };
    let idempotencyLookups = 0;
    let createCalls = 0;
    const prisma = {
      movement: {
        findUnique: async ({ where }: any) => {
          if (where.id === 'm1') return { ...original, wine };
          // idempotencyKey lookup: miss on the pre-check, hit once the racing create has landed
          idempotencyLookups += 1;
          if (idempotencyLookups === 1) return null;
          return { ...racedReversal, wine };
        },
        findFirst: async () => null,
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['idempotency_key'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 0 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    const r = await service.cancel('m1', 'cancel-1');
    expect(r.created).toBe(false);
    expect(r.movement.id).toBe('raced-2');
    expect(createCalls).toBe(1);
  });

  it('maps a concurrent double-cancel (racing on reversesId) to a 409, not a 500', async () => {
    const wine = { id: 'w1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const original = {
      id: 'm1',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k1',
      reversesId: null,
    };
    const prisma = {
      movement: {
        findUnique: async ({ where }: any) => (where.id === 'm1' ? { ...original, wine } : null),
        // both racing requests pass the pre-check: neither has inserted its reversal yet
        findFirst: async () => null,
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['reverses_id'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 6 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    await expect(service.cancel('m1', 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.cancel('m1', 'cancel-3')).rejects.toThrow(/déjà été annulé/);
  });
});
