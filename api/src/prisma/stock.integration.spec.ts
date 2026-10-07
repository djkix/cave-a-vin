import { PrismaClient, WineColor } from '@prisma/client';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('stock journal (trigger + stock_courant)', () => {
  const prisma = new PrismaClient();
  let caveId: string;
  let wineId: string;

  beforeAll(async () => {

    caveId = (await createTestCave(prisma)).id;
    const wine = await prisma.wine.create({
      data: {
        caveId,
        matchKey: `test|${Date.now()}`,
        producer: 'Domaine Test',
        appellationRaw: 'Test AOC',
        color: WineColor.ROUGE,
      },
    });
    wineId = wine.id;
  });

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId } });
    await prisma.wine.delete({ where: { id: wineId } });
    await deleteTestCaves(prisma, [caveId]);
    await prisma.$disconnect();
  });

  it('refuses a movement that would make stock negative', async () => {
    await expect(
      prisma.movement.create({
        data: { wineId, delta: -1, type: 'OUT', idempotencyKey: `neg-${Date.now()}` },
      }),
    ).rejects.toThrow(/il ne reste aucune bouteille/);
  });

  it('sums movements into stock_courant', async () => {
    await prisma.movement.create({
      data: { wineId, delta: 6, type: 'IN', idempotencyKey: `in6-${Date.now()}` },
    });
    await prisma.movement.create({
      data: { wineId, delta: -1, type: 'OUT', idempotencyKey: `out1-${Date.now()}` },
    });
    const rows = await prisma.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock_courant WHERE wine_id = ${wineId}`;
    expect(rows[0].quantity).toBe(5);
  });

  it('refuses a zero delta', async () => {
    await expect(
      prisma.movement.create({
        data: { wineId, delta: 0, type: 'ADJUST', idempotencyKey: `zero-${Date.now()}` },
      }),
    ).rejects.toThrow(/ne peut pas être nul/);
  });

  it('reste exact quand deux mouvements se croisent', async () => {
    // Un mouvement validé pendant qu'un autre s'enregistre ne doit jamais
    // disparaître du stock (l'ancienne vue matérialisée le perdait).
    const other = await prisma.wine.create({
      data: { caveId, matchKey: `test-other|${Date.now()}`, producer: 'Domaine Croisé', appellationRaw: 'Test AOC', color: WineColor.ROUGE },
    });
    const second = new PrismaClient();
    try {
      await second.$queryRaw`SELECT 1`; // connexion ouverte avant la course
      const before = await prisma.$queryRaw<{ quantity: number }[]>`SELECT quantity FROM stock_courant WHERE wine_id = ${wineId}`;
      const start = before[0]?.quantity ?? 0;
      let concurrent: Promise<unknown> | undefined;
      await prisma.$transaction(async (tx) => {
        await tx.movement.create({ data: { wineId, delta: 4, type: 'IN', idempotencyKey: `cross-a-${Date.now()}` } });
        // .then() lance la requête tout de suite : une requête Prisma ne part qu'une fois attendue.
        concurrent = second.movement.create({ data: { wineId: other.id, delta: 2, type: 'IN', idempotencyKey: `cross-b-${Date.now()}` } }).then((m) => m);
        await new Promise((r) => setTimeout(r, 300));
      });
      await concurrent;
      const rows = await prisma.$queryRaw<{ wine_id: string; quantity: number }[]>`
        SELECT wine_id, quantity FROM stock_courant WHERE wine_id IN (${wineId}, ${other.id})`;
      const stock = Object.fromEntries(rows.map((r) => [r.wine_id, Number(r.quantity)]));
      expect(stock[wineId]).toBe(start + 4);
      expect(stock[other.id]).toBe(2);
    } finally {
      await second.$disconnect();
      await prisma.movement.deleteMany({ where: { wineId: other.id } });
      await prisma.wine.delete({ where: { id: other.id } });
    }
  });
});
