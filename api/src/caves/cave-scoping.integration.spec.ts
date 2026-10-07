import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient, WineColor } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { AppellationsService } from '../appellations/appellations.service';
import { CaveService } from '../cave/cave.service';
import { ExportService } from '../export/export.service';
import { MovementsService } from '../movements/movements.service';
import { StatsService } from '../stats/stats.service';
import { createTestCave } from '../test-utils/cave';
import { WineMatchingService } from '../wines/wine-matching.service';

// Étanchéité des services, sur la base de test : un identifiant d'une autre
// cave se comporte exactement comme un identifiant inconnu (même 404, même message).
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('services filtrés par cave (base réelle)', () => {
  const prisma = new PrismaClient();
  const rules = new ApogeeRulesService(prisma as never);
  const cave = new CaveService(prisma as never, rules);
  const matching = new WineMatchingService(prisma as never, new AppellationsService(prisma as never));
  const movements = new MovementsService(prisma as never, matching);
  const stats = new StatsService(prisma as never, cave, rules);
  const exporter = new ExportService(prisma as never, rules);
  const run = randomUUID().slice(0, 8);
  let caveA: string;
  let caveB: string;
  let userId: string;
  let wineA: string;
  let movementA: { id: string; idempotencyKey: string };
  let photoA: string;

  beforeAll(async () => {
    caveA = (await createTestCave(prisma, { name: `Étanche A ${run}` })).id;
    caveB = (await createTestCave(prisma, { name: `Étanche B ${run}` })).id;
    userId = (await prisma.appUser.create({ data: { email: `scope-${run}@example.test` } })).id;
    const wine = await prisma.wine.create({
      data: { caveId: caveA, matchKey: `scope-${run}`, producer: `Domaine Étanche ${run}`, appellationRaw: 'Bandol', color: WineColor.ROUGE, vintage: 2015 },
    });
    wineA = wine.id;
    const m = await prisma.movement.create({
      data: { wineId: wineA, delta: 6, type: 'IN', priceUnitCents: 4200, idempotencyKey: `scope-in-${run}` },
    });
    movementA = { id: m.id, idempotencyKey: m.idempotencyKey };
    photoA = (await prisma.photo.create({
      data: { caveId: caveA, contentHash: `scope-${run}`, storagePath: 'normalized/x.jpg', status: 'DONE', purpose: 'EXIT' },
    })).id;
  });

  afterAll(async () => {
    const caves = [caveA, caveB];
    await prisma.movement.deleteMany({ where: { wine: { caveId: { in: caves } } } });
    await prisma.pairing.deleteMany({ where: { wine: { caveId: { in: caves } } } });
    await prisma.wine.deleteMany({ where: { caveId: { in: caves } } });
    await prisma.photo.deleteMany({ where: { caveId: { in: caves } } });
    await prisma.exportLog.deleteMany({ where: { caveId: { in: caves } } });
    await prisma.cave.deleteMany({ where: { id: { in: caves } } });
    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function rejects404(p: Promise<unknown>, message: string) {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as Error).message).toBe(message);
  }

  describe('CaveService', () => {
    it('la liste ne montre que les vins de la cave', async () => {
      expect((await cave.list(caveA, { includeEmpty: true })).map((w) => w.id)).toContain(wineA);
      expect((await cave.list(caveB, { includeEmpty: true })).map((w) => w.id)).not.toContain(wineA);
    });

    it('fiche, apogée manuelle et note d’un vin d’une autre cave : 404 « Vin introuvable », sans écrire', async () => {
      await expect(cave.detail(caveA, wineA)).resolves.toMatchObject({ wine: { id: wineA } });
      await rejects404(cave.detail(caveB, wineA), 'Vin introuvable');
      await rejects404(cave.detail(caveB, randomUUID()), 'Vin introuvable');
      await rejects404(cave.setManualApogee(caveB, wineA, { min: 2030, max: 2035 }), 'Vin introuvable');
      await rejects404(cave.clearManualApogee(caveB, wineA), 'Vin introuvable');
      await rejects404(cave.setRating(caveB, wineA, 15, userId), 'Vin introuvable');
      await rejects404(cave.clearRating(caveB, wineA), 'Vin introuvable');
      const unchanged = await prisma.wine.findUniqueOrThrow({ where: { id: wineA } });
      expect(unchanged).toMatchObject({ apogeeMin: null, rating: null });
    });

    it('les candidates de sortie d’une photo d’une autre cave : 404 « Photo introuvable »', async () => {
      await rejects404(cave.exitCandidates(caveB, photoA), 'Photo introuvable');
      await rejects404(cave.exitCandidates(caveB, randomUUID()), 'Photo introuvable');
    });
  });

  describe('MovementsService', () => {
    it('sortie, inventaire et annulation sur une autre cave : 404, sans mouvement écrit', async () => {
      const before = await prisma.movement.count({ where: { wineId: wineA } });
      await rejects404(movements.createOut(caveB, { idempotencyKey: randomUUID(), wineId: wineA, quantity: 1 }), 'Vin introuvable');
      await rejects404(movements.adjustTo(caveB, wineA, { idempotencyKey: randomUUID(), counted: 0 }), 'Vin introuvable');
      await rejects404(movements.cancel(caveB, movementA.id, randomUUID()), 'Mouvement introuvable');
      await rejects404(movements.cancel(caveB, randomUUID(), randomUUID()), 'Mouvement introuvable');
      expect(await prisma.movement.count({ where: { wineId: wineA } })).toBe(before);
    });

    it('rejouer la clé d’un mouvement d’une autre cave ne le dévoile pas', async () => {
      const draft = { producer: 'Domaine Rejeu', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75 };
      await expect(movements.createIn(caveB, { idempotencyKey: movementA.idempotencyKey, quantity: 1, wine: draft })).rejects.toBeInstanceOf(ConflictException);
      await expect(movements.cancel(caveB, randomUUID(), movementA.idempotencyKey)).rejects.toBeInstanceOf(ConflictException);
      await expect(movements.createOut(caveB, { idempotencyKey: movementA.idempotencyKey, wineId: wineA, quantity: 1 })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('une entrée avec la photo d’une autre cave : 404 « Photo introuvable »', async () => {
      const draft = { producer: 'Domaine Photo', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75 };
      await rejects404(movements.createIn(caveB, { idempotencyKey: randomUUID(), photoId: photoA, quantity: 1, wine: draft }), 'Photo introuvable');
      await rejects404(movements.createOut(caveB, { idempotencyKey: randomUUID(), wineId: (await bWine()).id, quantity: 1, photoId: photoA }), 'Photo introuvable');
    });

    it('le journal ne montre que les mouvements de la cave', async () => {
      expect((await movements.recent(caveA, 100)).map((m) => m.id)).toContain(movementA.id);
      expect((await movements.recent(caveB, 100)).every((m) => m.wine.caveId === caveB)).toBe(true);
    });

    it('le même vin entré dans deux caves donne deux fiches (rapprochement par cave)', async () => {
      const draft = { producer: `Domaine Jumeau ${run}`, appellationRaw: 'Bandol', vintage: 2018, color: 'ROUGE' as const, formatCl: 75 };
      const a = await movements.createIn(caveA, { idempotencyKey: randomUUID(), quantity: 2, wine: draft });
      const b = await movements.createIn(caveB, { idempotencyKey: randomUUID(), quantity: 1, wine: draft });
      const again = await movements.createIn(caveA, { idempotencyKey: randomUUID(), quantity: 1, wine: draft });
      expect(a.wine.id).not.toBe(b.wine.id);
      expect([a.wine.caveId, b.wine.caveId]).toEqual([caveA, caveB]);
      expect(a.wine.matchKey).toBe(b.wine.matchKey);
      expect(again.wine.id).toBe(a.wine.id);
      expect([again.stock, b.stock]).toEqual([3, 1]);
    });
  });

  async function bWine() {
    return prisma.wine.upsert({
      where: { caveId_matchKey: { caveId: caveB, matchKey: `scope-b-${run}` } },
      update: {},
      create: { caveId: caveB, matchKey: `scope-b-${run}`, producer: 'Domaine B', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
  }

  describe('StatsService et ExportService', () => {
    it('les statistiques ne comptent que la cave', async () => {
      const a = await stats.compute(caveA, 'OWNER');
      const b = await stats.compute(caveB, 'OWNER');
      expect(a.bottles).toBeGreaterThanOrEqual(6);
      expect('purchaseValueCents' in a && a.purchaseValueCents).toBeGreaterThanOrEqual(6 * 4200);
      expect(b.bottles).toBe((await cave.list(caveB, {})).reduce((s, w) => s + w.quantity, 0));
    });

    it('pour un VIEWER, les statistiques n’ont aucun champ de prix', async () => {
      const viewer = await stats.compute(caveA, 'VIEWER');
      expect(Object.keys(viewer)).not.toEqual(expect.arrayContaining(['purchaseValueCents']));
      for (const k of ['purchaseValueCents', 'pricedReferences', 'mostExpensive']) expect(viewer).not.toHaveProperty(k);
      expect(viewer.bottles).toBeGreaterThanOrEqual(6);
    });

    it('l’export ne contient que la cave et se journalise dans la cave', async () => {
      const a = await exporter.buildWorkbook(caveA, {}, userId);
      const b = await exporter.buildWorkbook(caveB, {}, userId);
      expect(a.rowCount).toBeGreaterThanOrEqual(1);
      expect(b.rowCount).toBe((await cave.list(caveB, {})).length);
      expect(await prisma.exportLog.count({ where: { caveId: caveB, userId } })).toBe(1);
    });
  });
});
