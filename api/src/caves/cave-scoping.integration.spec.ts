import { ConflictException, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PrismaClient, WineColor } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { AppellationsService } from '../appellations/appellations.service';
import { CaveService } from '../cave/cave.service';
import { ExportService } from '../export/export.service';
import { MovementsService } from '../movements/movements.service';
import { LocationsService } from '../locations/locations.service';
import { StatsService } from '../stats/stats.service';
import { createTestCave } from '../test-utils/cave';
import { WineMatchingService } from '../wines/wine-matching.service';

// Étanchéité des services, sur la base de test : un identifiant d'une autre
// cave se comporte exactement comme un identifiant inconnu (même 404, même message).
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('services filtrés par cave (base réelle)', () => {
  const prisma = new PrismaClient();
  const rules = new ApogeeRulesService(prisma as never);
  const locations = new LocationsService(prisma as never);
  const cave = new CaveService(prisma as never, rules, locations);
  const matching = new WineMatchingService(prisma as never, new AppellationsService(prisma as never));
  const movements = new MovementsService(prisma as never, matching, locations);
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
      data: { wineId: wineA, delta: 6, type: 'IN', priceUnitCents: 4200, note: `Note A ${run}`, idempotencyKey: `scope-in-${run}` },
    });
    movementA = { id: m.id, idempotencyKey: m.idempotencyKey };
    await prisma.movement.create({
      data: { wineId: (await bWine()).id, delta: 2, type: 'IN', priceUnitCents: 1700, note: `Note B ${run}`, idempotencyKey: `scope-in-b-${run}` },
    });
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

    it('auteur de la note : nom affiché ou null pour un VIEWER, jamais l’e-mail ; e-mail à défaut de nom pour l’OWNER', async () => {
      const rater = await prisma.appUser.create({ data: { email: `scope-rater-${run}@example.test` } });
      try {
        await cave.setRating(caveA, wineA, 15, rater.id);
        const ratedBy = async (role: 'OWNER' | 'VIEWER') => [
          (await cave.list(caveA, { includeEmpty: true }, role)).find((w) => w.id === wineA)!.rating?.ratedBy,
          (await cave.detail(caveA, wineA, role)).wine.rating?.ratedBy,
        ];
        expect(await ratedBy('OWNER')).toEqual([rater.email, rater.email]);
        expect(await ratedBy('VIEWER')).toEqual([null, null]);
        expect(JSON.stringify(await cave.detail(caveA, wineA, 'VIEWER'))).not.toContain(rater.email);
        await prisma.appUser.update({ where: { id: rater.id }, data: { displayName: 'Goûteur' } });
        expect(await ratedBy('VIEWER')).toEqual(['Goûteur', 'Goûteur']);
        expect(await ratedBy('OWNER')).toEqual(['Goûteur', 'Goûteur']);
      } finally {
        await cave.clearRating(caveA, wineA);
        await prisma.appUser.delete({ where: { id: rater.id } });
      }
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
      create: { caveId: caveB, matchKey: `scope-b-${run}`, producer: `Domaine B ${run}`, appellationRaw: 'Bandol', color: WineColor.ROUGE },
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

    /** Toutes les cellules d'une feuille, en texte. */
    async function sheets(buffer: Buffer): Promise<Record<string, string[]>> {
      const wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- même contournement que export.service.spec (Buffer d'exceljs)
      await wb.xlsx.load(buffer as any);
      const out: Record<string, string[]> = {};
      wb.eachSheet((ws) => {
        const cells: string[] = [];
        ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value))));
        out[ws.name] = cells;
      });
      return out;
    }

    it('l’export ne contient que la cave, aucune feuille ne cite l’autre, et se journalise dans la cave', async () => {
      const a = await exporter.buildWorkbook(caveA, {}, userId);
      const b = await exporter.buildWorkbook(caveB, {}, userId);
      expect(a.rowCount).toBeGreaterThanOrEqual(1);
      expect(b.rowCount).toBe((await cave.list(caveB, {})).length);
      expect(await prisma.exportLog.count({ where: { caveId: caveB, userId } })).toBe(1);

      const own = { a: [`Domaine Étanche ${run}`, `Note A ${run}`], b: [`Domaine B ${run}`, `Note B ${run}`] };
      const [sheetsA, sheetsB] = [await sheets(a.buffer), await sheets(b.buffer)];
      // Témoin : chaque classeur cite bien sa propre cave, journal compris.
      expect(sheetsA.Stock).toContain(own.a[0]);
      expect(sheetsA.Mouvements).toEqual(expect.arrayContaining([...own.a, '42']));
      expect(sheetsB.Stock).toContain(own.b[0]);
      expect(sheetsB.Mouvements).toEqual(expect.arrayContaining([...own.b, '17']));
      for (const [book, foreign, foreignPrice] of [[sheetsB, own.a, '42'], [sheetsA, own.b, '17']] as const) {
        for (const [name, cells] of Object.entries(book)) {
          for (const text of foreign) expect({ name, hit: cells.some((c) => c.includes(text)) }).toEqual({ name, hit: false });
        }
        // Le journal porte les prix : le prix de l'autre cave n'y figure pas.
        expect(book.Mouvements).not.toContain(foreignPrice);
      }
    });
  });
});
