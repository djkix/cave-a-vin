import { ConflictException } from '@nestjs/common';
import { PrismaClient, WineColor } from '@prisma/client';
import { MovementsService } from './movements.service';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

describeIfDb('sortie par photo réutilisée (base réelle)', () => {
  const prisma = new PrismaClient();
  let caveId: string;

  beforeAll(async () => {
    caveId = (await createTestCave(prisma)).id;
  });
  const service = new MovementsService(prisma as never, {} as never);
  const wineIds: string[] = [];
  const photoIds: string[] = [];

  async function wineWithStock(quantity: number) {
    const wine = await prisma.wine.create({
      data: { caveId, matchKey: key('photo-out'), producer: 'Domaine Photo', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineIds.push(wine.id);
    await prisma.movement.create({ data: { wineId: wine.id, delta: quantity, type: 'IN', idempotencyKey: key('in') } });
    return wine;
  }

  async function exitPhoto() {
    const p = await prisma.photo.create({ data: { caveId, contentHash: key('hash'), storagePath: 'normalized/x.jpg', purpose: 'EXIT' } });
    photoIds.push(p.id);
    return p;
  }

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId: { in: wineIds }, reversesId: { not: null } } });
    await prisma.movement.deleteMany({ where: { wineId: { in: wineIds } } });
    await prisma.wine.deleteMany({ where: { id: { in: wineIds } } });
    await prisma.photo.deleteMany({ where: { id: { in: photoIds } } });
    await deleteTestCaves(prisma, [caveId]);
    await prisma.$disconnect();
  });

  it('après l’annulation, la même photo sort bien l’autre millésime', async () => {
    const a = await wineWithStock(2);
    const b = await wineWithStock(2);
    const p = await exitPhoto();
    const outA = await service.createOut(caveId, { idempotencyKey: crypto.randomUUID(), wineId: a.id, quantity: 1, photoId: p.id });
    await service.cancel(caveId, outA.movement.id, crypto.randomUUID());
    const outB = await service.createOut(caveId, { idempotencyKey: crypto.randomUUID(), wineId: b.id, quantity: 1, photoId: p.id });
    expect(outB.created).toBe(true);
    expect(outB.movement.wineId).toBe(b.id);
    expect(await service.stockOf(b.id)).toBe(1);
    expect(await service.stockOf(a.id)).toBe(2);
  });

  it('sans annulation, la même photo ne sort pas un autre vin : 409 et stock intact', async () => {
    const a = await wineWithStock(2);
    const b = await wineWithStock(2);
    const p = await exitPhoto();
    await service.createOut(caveId, { idempotencyKey: crypto.randomUUID(), wineId: a.id, quantity: 1, photoId: p.id });
    await expect(
      service.createOut(caveId, { idempotencyKey: crypto.randomUUID(), wineId: b.id, quantity: 1, photoId: p.id }),
    ).rejects.toThrow(new ConflictException('Cette photo a déjà servi à sortir un autre vin — annulez d’abord cette sortie'));
    expect(await service.stockOf(b.id)).toBe(2);
    expect(await service.stockOf(a.id)).toBe(1);
  });
});
