import { PrismaClient, WineColor } from '@prisma/client';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('stock journal (trigger + stock_courant)', () => {
  const prisma = new PrismaClient();
  let wineId: string;

  beforeAll(async () => {
    const wine = await prisma.wine.create({
      data: {
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
});
