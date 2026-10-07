import { PrismaClient, WineColor } from '@prisma/client';
import { LocationsService } from '../locations/locations.service';
import { MovementsService } from './movements.service';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

describeIfDb('inventaire sous concurrence (base réelle)', () => {
  const prisma = new PrismaClient();
  let caveId: string;

  beforeAll(async () => {
    caveId = (await createTestCave(prisma)).id;
  });
  const service = new MovementsService(prisma as never, {} as never, new LocationsService(prisma as never));
  const wineIds: string[] = [];

  async function wineWithStock(quantity: number) {
    const wine = await prisma.wine.create({
      data: { caveId, matchKey: key('inv'), producer: 'Domaine Inventaire', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineIds.push(wine.id);
    if (quantity > 0) await prisma.movement.create({ data: { wineId: wine.id, delta: quantity, type: 'IN', idempotencyKey: key('inv-in') } });
    return wine;
  }

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId: { in: wineIds } } });
    await prisma.wine.deleteMany({ where: { id: { in: wineIds } } });
    await deleteTestCaves(prisma, [caveId]);
    await prisma.$disconnect();
  });

  it('deux inventaires simultanés du même compte n’écrivent l’écart qu’une fois', async () => {
    const wine = await wineWithStock(6);
    // Sans verrou, les deux calculeraient −2 sur un stock de 6 et laisseraient 2.
    const [a, b] = await Promise.all([
      service.adjustTo(caveId, wine.id, { idempotencyKey: crypto.randomUUID(), counted: 4 }),
      service.adjustTo(caveId, wine.id, { idempotencyKey: crypto.randomUUID(), counted: 4 }),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const sum = await prisma.movement.aggregate({ _sum: { delta: true }, where: { wineId: wine.id } });
    expect(sum._sum.delta).toBe(4);
  });

  it('attend le verrou avant de lire le stock : une sortie insérée pendant l’attente est prise en compte', async () => {
    const wine = await wineWithStock(6);
    let lockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    // Transaction A prend le verrou sur la ligne du vin, insère une sortie de 1
    // bouteille pendant qu'elle le détient, puis attend 300 ms avant de valider.
    // Sans le verrou dans adjustTo, celui-ci lirait le stock (6) avant que A ait
    // inséré sa sortie et commité, et écrirait un écart calculé sur un stock
    // périmé (6 au lieu de 5), laissant la somme finale à 3 au lieu de 4.
    const txA = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wine WHERE id = ${wine.id} FOR UPDATE`;
      lockAcquired();
      await tx.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', idempotencyKey: key('out-race') } });
      await sleep(300);
    });

    // adjustTo ne démarre qu'une fois le verrou de A posé : s'il n'attendait pas
    // lui-même ce verrou, il lirait le stock immédiatement (6) au lieu d'attendre
    // la fin de A (5).
    await locked;
    const adjustPromise = service.adjustTo(caveId, wine.id, { idempotencyKey: key('inv-adjust'), counted: 4 });

    await Promise.all([txA, adjustPromise]);

    const sum = await prisma.movement.aggregate({ _sum: { delta: true }, where: { wineId: wine.id } });
    expect(sum._sum.delta).toBe(4);
  });
});
