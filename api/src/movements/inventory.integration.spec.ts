import { PrismaClient, WineColor } from '@prisma/client';
import { MovementsService } from './movements.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('inventaire sous concurrence (base réelle)', () => {
  const prisma = new PrismaClient();
  const service = new MovementsService(prisma as never, {} as never);
  let wineId: string;

  beforeAll(async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `inv|${Date.now()}`, producer: 'Domaine Inventaire', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineId = wine.id;
    await prisma.movement.create({ data: { wineId, delta: 6, type: 'IN', idempotencyKey: `inv-in-${Date.now()}` } });
  });

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId } });
    await prisma.wine.delete({ where: { id: wineId } });
    await prisma.$disconnect();
  });

  it('deux inventaires simultanés du même compte n’écrivent l’écart qu’une fois', async () => {
    // Sans verrou, les deux calculeraient −2 sur un stock de 6 et laisseraient 2.
    const [a, b] = await Promise.all([
      service.adjustTo(wineId, { idempotencyKey: crypto.randomUUID(), counted: 4 }),
      service.adjustTo(wineId, { idempotencyKey: crypto.randomUUID(), counted: 4 }),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const sum = await prisma.movement.aggregate({ _sum: { delta: true }, where: { wineId } });
    expect(sum._sum.delta).toBe(4);
  });
});
