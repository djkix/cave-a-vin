import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppUser } from '@prisma/client';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

// Cote iDealwine saisie à la main, en HTTP contre le vrai AppModule : un
// propriétaire et un membre (VIEWER) de A, un propriétaire de B.
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfInfra('cote iDealwine (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('../prisma/prisma.service').PrismaService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const caveIds: string[] = [];
  let wineA: string;
  let wineA2: string;
  let wineEmpty: string;
  let wineB: string;
  let ownerA: supertest.Agent;
  let viewerA: supertest.Agent;
  let ownerB: supertest.Agent;

  const expectStatus = (res: supertest.Response, status: number, message: string) => {
    expect({ status: res.status, message: res.body?.message }).toEqual({ status, message });
  };
  const page = 'https://www.idealwine.com/fr/acheter-vin/B2210084-1.jsp';

  beforeAll(async () => {
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    delete process.env.BREAK_GLASS_EMAIL;
    delete process.env.BREAK_GLASS_PASSWORD;

    const { AppModule } = await import('../app.module');
    const { setupSession } = await import('../auth/session.setup');
    const { PrismaService } = await import('../prisma/prisma.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    sessionRedis = setupSession(app);
    prisma = app.get(PrismaService);
    app.use('/__test/login', (req: any, res: any) => {
      prisma.appUser
        .findUniqueOrThrow({ where: { id: String(req.query.id) } })
        .then((user) => req.logIn(user, (err: unknown) => (err ? res.status(500).end() : res.status(204).end())))
        .catch(() => res.status(500).end());
    });
    await app.listen(0, '127.0.0.1');

    const user = async (name: string, displayName: string | null) => {
      const u = await prisma.appUser.create({ data: { email: `quotes-${run}-${name}@example.test`, displayName } });
      userIds.push(u.id);
      return u;
    };
    const [uOwnerA, uViewerA, uOwnerB] = [await user('owner-a', 'Franck'), await user('viewer-a', 'Membre'), await user('owner-b', null)];
    const caveA = (await createTestCave(prisma, { owner: uOwnerA, name: `Cotes A ${run}` })).id;
    const caveB = (await createTestCave(prisma, { owner: uOwnerB, name: `Cotes B ${run}` })).id;
    caveIds.push(caveA, caveB);
    await prisma.caveMember.create({ data: { caveId: caveA, userId: uViewerA.id, role: 'VIEWER' } });

    const wine = async (caveId: string, name: string, cuvee: string | null, quantity: number) => {
      const w = await prisma.wine.create({
        data: { caveId, matchKey: `quotes-${run}-${name}`, producer: `Château Côté ${name}`, cuvee, appellationRaw: 'Bandol', color: 'ROUGE', vintage: 2016 },
      });
      if (quantity) await prisma.movement.create({ data: { wineId: w.id, delta: quantity, type: 'IN', idempotencyKey: `quotes-${run}-${name}` } });
      return w.id;
    };
    wineA = await wine(caveA, 'a', 'Hommage à Jacques', 6);
    wineA2 = await wine(caveA, 'a2', null, 2);
    wineEmpty = await wine(caveA, 'vide', null, 0);
    wineB = await wine(caveB, 'b', null, 3);

    const signedIn = async (u: AppUser) => {
      const agent = supertest.agent(app.getHttpServer());
      expect((await agent.get(`/__test/login?id=${u.id}`)).status).toBe(204);
      return agent;
    };
    [ownerA, viewerA, ownerB] = [await signedIn(uOwnerA), await signedIn(uViewerA), await signedIn(uOwnerB)];
  }, 120_000);

  afterAll(async () => {
    if (prisma && caveIds.length) {
      await deleteTestCaves(prisma, caveIds);
      await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
  });

  const quoteCount = () => prisma.priceQuote.count({ where: { wineId: { in: [wineA, wineA2, wineEmpty, wineB] } } });

  describe('fiche sans cote', () => {
    it('propriétaire : quote null et lien de recherche iDealwine', async () => {
      const res = await ownerA.get(`/api/wines/${wineA}`);
      expect(res.status).toBe(200);
      expect(res.body.quote).toBeNull();
      expect(res.body.idealwineUrl).toBe(`https://www.idealwine.com/fr/acheter-du-vin/recherche-chateau%20cote%20a%20hommage%20a%20jacques`);
    });
  });

  describe('POST /api/wines/:id/quotes', () => {
    it('propriétaire : 201, la cote créée, saisie par lui', async () => {
      const res = await ownerA.post(`/api/wines/${wineA}/quotes`).send({ coteCents: 8500, nTransactions: 12, quotedOn: '2026-03-03', sourceUrl: page });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ coteCents: 8500, nTransactions: 12, quotedOn: '2026-03-03', sourceUrl: page, enteredBy: 'Franck', cessionCents: 7328 });
      const row = await prisma.priceQuote.findFirstOrThrow({ where: { wineId: wineA } });
      expect(row).toMatchObject({ source: 'IDEALWINE', enteredById: userIds[0] });
    });

    it('une cote plus ancienne saisie ensuite ne devient pas la cote courante', async () => {
      const res = await ownerA.post(`/api/wines/${wineA}/quotes`).send({ coteCents: 9900, quotedOn: '2025-01-01' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ nTransactions: null, sourceUrl: null });
      const detail = await ownerA.get(`/api/wines/${wineA}`);
      expect(detail.body.quote).toMatchObject({ coteCents: 8500, quotedOn: '2026-03-03' });
      expect(detail.body.idealwineUrl).toBe(page);
    });

    it.each([
      [{ coteCents: 0, quotedOn: '2026-03-03' }, 'La cote doit être comprise entre 0,01 € et 100 000 €'],
      [{ coteCents: 100, nTransactions: -1, quotedOn: '2026-03-03' }, 'Nombre de transactions invalide'],
      [{ coteCents: 100, quotedOn: '1989-12-31' }, 'Date de cote invalide'],
      [{ coteCents: 100, quotedOn: '2026-03-03', sourceUrl: 'https://www.idealwine.com.evil.test/' }, 'Le lien doit être une page www.idealwine.com'],
    ])('400 %j', async (body, message) => {
      const before = await quoteCount();
      expectStatus(await ownerA.post(`/api/wines/${wineA}/quotes`).send(body), 400, message);
      expect(await quoteCount()).toBe(before);
    });

    it('membre : 403 « Lecture seule », rien écrit', async () => {
      const before = await quoteCount();
      expectStatus(await viewerA.post(`/api/wines/${wineA}/quotes`).send({ coteCents: 100, quotedOn: '2026-03-03' }), 403, 'Lecture seule');
      expect(await quoteCount()).toBe(before);
    });

    it('vin d’une autre cave : 404 « Vin introuvable », rien écrit', async () => {
      const before = await quoteCount();
      expectStatus(await ownerB.post(`/api/wines/${wineA}/quotes`).send({ coteCents: 100, quotedOn: '2026-03-03' }), 404, 'Vin introuvable');
      expectStatus(await ownerA.post(`/api/wines/${wineB}/quotes`).send({ coteCents: 100, quotedOn: '2026-03-03' }), 404, 'Vin introuvable');
      expectStatus(await ownerA.post(`/api/wines/${randomUUID()}/quotes`).send({ coteCents: 100, quotedOn: '2026-03-03' }), 404, 'Vin introuvable');
      expect(await quoteCount()).toBe(before);
    });
  });

  describe('fiche, statistiques et export', () => {
    beforeAll(async () => {
      // Vin épuisé coté : compté nulle part dans la valeur à la cote.
      await prisma.priceQuote.create({ data: { wineId: wineEmpty, coteCents: 50000, quotedOn: new Date('2026-01-01') } });
    });

    it('fiche : le membre ne reçoit ni quote ni idealwineUrl (clés absentes)', async () => {
      const res = await viewerA.get(`/api/wines/${wineA}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('quote');
      expect(res.body).not.toHaveProperty('idealwineUrl');
      // Clés seulement : le nom du vin (« Château Côté ») contient lui-même « cote ».
      const keysOf = (v: unknown): string[] =>
        Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
      expect(keysOf(res.body).filter((k) => /quote|cote|idealwine|cession|savedurl/i.test(k))).toEqual([]);
    });

    it('statistiques : valeur à la cote pour le propriétaire, absente pour le membre', async () => {
      const owner = await ownerA.get('/api/stats');
      expect(owner.status).toBe(200);
      expect(owner.body).toMatchObject({ quotedValueCents: 6 * 8500, cessionValueCents: Math.round((6 * 8500) / 1.16), quotedReferences: 1, quotableReferences: 2 });
      const viewer = await viewerA.get('/api/stats');
      expect(viewer.status).toBe(200);
      for (const k of ['quotedValueCents', 'cessionValueCents', 'quotedReferences', 'quotableReferences']) expect(viewer.body).not.toHaveProperty(k);
    });

    it('export : colonnes cote, date et valeur à la cote', async () => {
      const res = await ownerA.get('/api/export.xlsx').buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir export.service.spec
      await wb.xlsx.load(res.body as any);
      const stock = wb.getWorksheet('Stock')!;
      const header = (stock.getRow(1).values as unknown[]).slice(1);
      const col = (name: string) => header.indexOf(name) + 1;
      expect(col('Cote iDealwine (€)')).toBeGreaterThan(0);
      const rowOf = (producer: string) => {
        for (let r = 2; r <= stock.rowCount; r++) if (stock.getRow(r).getCell(1).value === producer) return stock.getRow(r);
        throw new Error(producer);
      };
      const a = rowOf('Château Côté a');
      expect(a.getCell(col('Cote iDealwine (€)')).value).toBe(85);
      expect(a.getCell(col('Date de la cote')).value).toEqual(new Date('2026-03-03T00:00:00Z'));
      expect(a.getCell(col('Valeur à la cote (€)')).value).toBe(510);
      expect(rowOf('Château Côté a2').getCell(col('Cote iDealwine (€)')).value).toBeNull();
    });

    it('export : interdit au membre', async () => {
      expect((await viewerA.get('/api/export.xlsx')).status).toBe(403);
    });
  });
});
