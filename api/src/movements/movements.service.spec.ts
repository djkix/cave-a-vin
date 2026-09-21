import { ConflictException } from '@nestjs/common';
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
});
