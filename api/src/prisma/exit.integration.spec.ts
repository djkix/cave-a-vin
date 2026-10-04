import { PrismaClient, WineColor } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

describeIfDb('lot 2a — sortie (base réelle)', () => {
  const prisma = new PrismaClient();
  const wineIds: string[] = [];
  const photoIds: string[] = [];

  async function wineWithStock(quantity: number) {
    const wine = await prisma.wine.create({
      data: { matchKey: key('lot2a'), producer: 'Domaine Test', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineIds.push(wine.id);
    if (quantity > 0) await prisma.movement.create({ data: { wineId: wine.id, delta: quantity, type: 'IN', idempotencyKey: key('in') } });
    return wine;
  }

  async function photo(purpose: 'ENTRY' | 'EXIT' = 'ENTRY') {
    const p = await prisma.photo.create({ data: { contentHash: key('hash'), storagePath: 'normalized/x.jpg', purpose } });
    photoIds.push(p.id);
    return p;
  }

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId: { in: wineIds } } });
    await prisma.wine.deleteMany({ where: { id: { in: wineIds } } });
    await prisma.photo.deleteMany({ where: { id: { in: photoIds } } });
    await prisma.$disconnect();
  });

  it('ne laisse passer qu’une des deux sorties simultanées de la dernière bouteille', async () => {
    const wine = await wineWithStock(1);
    // La première sortie reste non validée pendant 400 ms : sans verrou, la seconde
    // lirait encore « 1 en stock » et passerait aussi, laissant le stock à -1.
    const first = prisma.$transaction(async (tx) => {
      await tx.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', idempotencyKey: key('out-a') } });
      await sleep(400);
    });
    await sleep(100);
    const second = prisma.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', idempotencyKey: key('out-b') } });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const sum = await prisma.movement.aggregate({ _sum: { delta: true }, where: { wineId: wine.id } });
    expect(sum._sum.delta).toBe(0);
  });

  it('refuse une seconde sortie avec la même photo, même avec une autre clé d’idempotence', async () => {
    const wine = await wineWithStock(3);
    const p = await photo('EXIT');
    await prisma.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', photoId: p.id, idempotencyKey: key('o1') } });
    await expect(
      prisma.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', photoId: p.id, idempotencyKey: key('o2') } }),
    ).rejects.toThrow();
  });

  it('le rattrapage retient la photo de la plus ancienne entrée comme photo de référence', async () => {
    const wine = await wineWithStock(0);
    const older = await photo();
    const newer = await photo();
    await prisma.movement.create({ data: { wineId: wine.id, delta: 2, type: 'IN', photoId: newer.id, idempotencyKey: key('n'), occurredAt: new Date('2026-09-02') } });
    await prisma.movement.create({ data: { wineId: wine.id, delta: 1, type: 'IN', photoId: older.id, idempotencyKey: key('o'), occurredAt: new Date('2026-09-01') } });
    // La migration a déjà tourné avant les tests : on rejoue sa requête de
    // rattrapage, lue dans le fichier même, pour tester le SQL livré.
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261004000000_lot2a_sortie/migration.sql'), 'utf8');
    const start = sql.indexOf('UPDATE wine w');
    await prisma.$executeRawUnsafe(sql.slice(start, sql.indexOf(';', start)));
    expect((await prisma.wine.findUnique({ where: { id: wine.id } }))?.referencePhotoId).toBe(older.id);
  });

  it('donne ENTRY par défaut à une photo', async () => {
    const p = await prisma.photo.create({ data: { contentHash: key('hash'), storagePath: 'normalized/y.jpg' } });
    photoIds.push(p.id);
    expect(p.purpose).toBe('ENTRY');
  });
});
