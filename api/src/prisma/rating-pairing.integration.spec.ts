import { PrismaClient, WineColor } from '@prisma/client';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('note et accords (base réelle)', () => {
  const prisma = new PrismaClient();
  let caveId: string;
  let wineId: string;

  beforeAll(async () => {

    caveId = (await createTestCave(prisma)).id;
    const wine = await prisma.wine.create({
      data: { caveId, matchKey: `rating-${Date.now()}`, producer: 'Domaine Note', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineId = wine.id;
  });

  afterAll(async () => {
    await prisma.wine.deleteMany({ where: { id: wineId } });
    await deleteTestCaves(prisma, [caveId]);
    await prisma.$disconnect();
  });

  it('accepte une note par demi-point entre 0 et 20', async () => {
    for (const rating of [0, 16.5, 20]) {
      await prisma.wine.update({ where: { id: wineId }, data: { rating } });
    }
    expect(Number((await prisma.wine.findUniqueOrThrow({ where: { id: wineId } })).rating)).toBe(20);
  });

  it('refuse en base une note hors bornes ou qui n’est pas un demi-point', async () => {
    await expect(prisma.$executeRaw`UPDATE wine SET rating = 20.5 WHERE id = ${wineId}`).rejects.toThrow(/wine_rating_valid/);
    await expect(prisma.$executeRaw`UPDATE wine SET rating = 16.3 WHERE id = ${wineId}`).rejects.toThrow(/wine_rating_valid/);
    await expect(prisma.$executeRaw`UPDATE wine SET rating = -1 WHERE id = ${wineId}`).rejects.toThrow(/wine_rating_valid/);
  });

  it('garde un seul jeu d’accords par vin et le supprime avec le vin', async () => {
    const other = await prisma.wine.create({
      data: { caveId, matchKey: `pairing-${Date.now()}`, producer: 'Domaine Accords', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    await prisma.pairing.create({ data: { wineId: other.id } });
    await expect(prisma.pairing.create({ data: { wineId: other.id } })).rejects.toThrow();
    const created = await prisma.pairing.findUniqueOrThrow({ where: { wineId: other.id } });
    expect(created).toMatchObject({ status: 'PENDING', dishes: [] });
    await prisma.wine.delete({ where: { id: other.id } });
    expect(await prisma.pairing.findUnique({ where: { wineId: other.id } })).toBeNull();
  });
});
