import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppUser } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { createTestCave } from '../test-utils/cave';

// Garde d'accès et étanchéité, en HTTP contre le vrai AppModule : deux caves A
// et B, un propriétaire de A, un membre (VIEWER) de A, un propriétaire de B.
// Comme accounts.e2e, une route de test montée par ce seul fichier ouvre la
// session d'un compte créé en base.
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

/** Toutes les clés d'une réponse JSON, à toute profondeur. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}
const PRICE_KEY = /price|purchase|expensive|valeur|cost/i;
const priceKeys = (body: unknown) => keysOf(body).filter((k) => PRICE_KEY.test(k));

describeIfInfra('garde d’accès et cave courante (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('../prisma/prisma.service').PrismaService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let caveA: string;
  let caveB: string;
  let wineA: string;
  let wineB: string;
  let movementA: string;
  let photoA: string;
  let ownerA: supertest.Agent;
  let viewerA: supertest.Agent;
  let ownerB: supertest.Agent;
  let noCave: supertest.Agent;

  const draft = (name: string) => ({ producer: `Domaine Accès ${run} ${name}`, appellationRaw: 'Bandol', vintage: 2015, color: 'ROUGE', formatCl: 75 });

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

    const user = async (name: string) => {
      const u = await prisma.appUser.create({ data: { email: `access-${run}-${name}@example.test`, displayName: name } });
      userIds.push(u.id);
      return u;
    };
    const [uOwnerA, uViewerA, uOwnerB, uNoCave] = [await user('owner-a'), await user('viewer-a'), await user('owner-b'), await user('no-cave')];
    caveA = (await createTestCave(prisma, { owner: uOwnerA, name: `Accès A ${run}` })).id;
    caveB = (await createTestCave(prisma, { owner: uOwnerB, name: `Accès B ${run}` })).id;
    await prisma.caveMember.create({ data: { caveId: caveA, userId: uViewerA.id, role: 'VIEWER' } });

    const wine = (caveId: string, name: string) =>
      prisma.wine.create({ data: { caveId, matchKey: `access-${run}-${name}`, producer: draft(name).producer, appellationRaw: 'Bandol', color: 'ROUGE', vintage: 2015 } });
    wineA = (await wine(caveA, 'a')).id;
    wineB = (await wine(caveB, 'b')).id;
    movementA = (await prisma.movement.create({
      data: { wineId: wineA, delta: 12, type: 'IN', priceUnitCents: 4200, idempotencyKey: `access-${run}-in-a` },
    })).id;
    await prisma.movement.create({ data: { wineId: wineB, delta: 3, type: 'IN', priceUnitCents: 900, idempotencyKey: `access-${run}-in-b` } });
    photoA = (await prisma.photo.create({
      data: { caveId: caveA, contentHash: `access-${run}`, storagePath: 'normalized/x.jpg', status: 'PROCESSING', purpose: 'EXIT' },
    })).id;

    const signedIn = async (u: AppUser) => {
      const agent = supertest.agent(app.getHttpServer());
      expect((await agent.get(`/__test/login?id=${u.id}`)).status).toBe(204);
      return agent;
    };
    [ownerA, viewerA, ownerB, noCave] = [await signedIn(uOwnerA), await signedIn(uViewerA), await signedIn(uOwnerB), await signedIn(uNoCave)];
  }, 120_000);

  afterAll(async () => {
    if (prisma && caveA) {
      const caves = [caveA, caveB];
      const wines = await prisma.wine.findMany({ where: { caveId: { in: caves } }, select: { producer: true } });
      await prisma.movement.deleteMany({ where: { wine: { caveId: { in: caves } } } });
      await prisma.pairing.deleteMany({ where: { wine: { caveId: { in: caves } } } });
      await prisma.wine.deleteMany({ where: { caveId: { in: caves } } });
      await prisma.photo.deleteMany({ where: { caveId: { in: caves } } });
      await prisma.exportLog.deleteMany({ where: { caveId: { in: caves } } });
      await prisma.producerProfile.deleteMany({ where: { displayName: { in: wines.map((w) => w.producer) } } });
      await prisma.cave.deleteMany({ where: { id: { in: caves } } });
      await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
  });

  function expectReadOnly(res: supertest.Response) {
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Lecture seule');
  }
  function expectNotFound(res: supertest.Response, message: string) {
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(message);
  }

  it('sans cave accessible : 404 « Cave introuvable » sur chaque route de cave', async () => {
    for (const res of [
      await noCave.get('/api/cave'),
      await noCave.get(`/api/wines/${wineA}`),
      await noCave.get('/api/stats'),
      await noCave.get('/api/movements/recent'),
      await noCave.get('/api/export.xlsx'),
      await noCave.post('/api/movements').send({ idempotencyKey: randomUUID(), quantity: 1, wine: draft('aucune') }),
    ]) expectNotFound(res, 'Cave introuvable');
  });

  describe('lecture (VIEWER)', () => {
    it('liste de la cave, filtres et recherche par plat : propriétaire et membre, jamais un étranger', async () => {
      for (const agent of [ownerA, viewerA]) {
        const res = await agent.get('/api/cave');
        expect(res.status).toBe(200);
        expect(res.body.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([wineA]));
        expect(res.body.map((w: { id: string }) => w.id)).not.toContain(wineB);
        expect((await agent.get('/api/cave?color=ROUGE&drinkSoon=true')).status).toBe(200);
        expect((await agent.get('/api/cave?dish=agneau')).status).toBe(200);
      }
      const other = await ownerB.get('/api/cave');
      expect(other.status).toBe(200);
      expect(other.body.map((w: { id: string }) => w.id)).toEqual([wineB]);
    });

    it('fiche vin : propriétaire et membre ; 404 « Vin introuvable » pour la cave B', async () => {
      for (const agent of [ownerA, viewerA]) {
        const res = await agent.get(`/api/wines/${wineA}`);
        expect(res.status).toBe(200);
        expect(res.body.wine).toMatchObject({ id: wineA, quantity: 12 });
        expect(res.body.movements.map((m: { id: string }) => m.id)).toContain(movementA);
      }
      expectNotFound(await ownerB.get(`/api/wines/${wineA}`), 'Vin introuvable');
      expectNotFound(await ownerB.get(`/api/wines/${randomUUID()}`), 'Vin introuvable');
    });

    it('statistiques : le propriétaire voit les prix, le membre n’en reçoit aucun champ', async () => {
      const owner = await ownerA.get('/api/stats');
      expect(owner.status).toBe(200);
      expect(owner.body).toMatchObject({ bottles: 12, references: 1, pricedReferences: 1, purchaseValueCents: 12 * 4200 });
      expect(owner.body.mostExpensive).toEqual([expect.objectContaining({ id: wineA, value: 4200 })]);

      const viewer = await viewerA.get('/api/stats');
      expect(viewer.status).toBe(200);
      expect(viewer.body).toMatchObject({ bottles: 12, references: 1 });
      for (const k of ['pricedReferences', 'purchaseValueCents', 'mostExpensive']) expect(viewer.body).not.toHaveProperty(k);
      expect(priceKeys(viewer.body)).toEqual([]);

      expect((await ownerB.get('/api/stats')).body).toMatchObject({ bottles: 3, purchaseValueCents: 3 * 900 });
    });

    it('aucune réponse lisible par le membre ne porte une clé de prix', async () => {
      for (const res of [await viewerA.get('/api/cave?includeEmpty=true'), await viewerA.get(`/api/wines/${wineA}`), await viewerA.get('/api/stats')]) {
        expect(res.status).toBe(200);
        expect(priceKeys(res.body)).toEqual([]);
      }
    });
  });

  describe('écriture et routes réservées (OWNER)', () => {
    it('le membre reçoit 403 « Lecture seule » partout, sans rien écrire', async () => {
      const before = await prisma.movement.count({ where: { wine: { caveId: caveA } } });
      for (const res of [
        await viewerA.post(`/api/wines/${wineA}/inventory`).send({ idempotencyKey: randomUUID(), counted: 1 }),
        await viewerA.get(`/api/photos/${photoA}/exit-candidates`),
        await viewerA.put(`/api/wines/${wineA}/apogee`).send({ min: 2030, max: 2035 }),
        await viewerA.delete(`/api/wines/${wineA}/apogee`),
        await viewerA.put(`/api/wines/${wineA}/rating`).send({ rating: 15 }),
        await viewerA.delete(`/api/wines/${wineA}/rating`),
        await viewerA.post('/api/movements').send({ idempotencyKey: randomUUID(), quantity: 1, wine: draft('membre') }),
        await viewerA.post('/api/movements/bulk').send([{ idempotencyKey: randomUUID(), quantity: 1, wine: draft('membre') }]),
        await viewerA.post('/api/movements/out').send({ idempotencyKey: randomUUID(), wineId: wineA, quantity: 1 }),
        await viewerA.post(`/api/movements/${movementA}/cancel`).send({ idempotencyKey: randomUUID() }),
        await viewerA.get('/api/movements/recent'),
        await viewerA.get('/api/export.xlsx'),
      ]) expectReadOnly(res);
      expect(await prisma.movement.count({ where: { wine: { caveId: caveA } } })).toBe(before);
      expect(await prisma.wine.findUniqueOrThrow({ where: { id: wineA } })).toMatchObject({ apogeeMin: null, rating: null });
    });

    it('le propriétaire de B reçoit 404 sur les vins, mouvements et photos de A, sans rien écrire', async () => {
      const before = await prisma.movement.count({ where: { wine: { caveId: caveA } } });
      for (const res of [
        await ownerB.post(`/api/wines/${wineA}/inventory`).send({ idempotencyKey: randomUUID(), counted: 1 }),
        await ownerB.put(`/api/wines/${wineA}/apogee`).send({ min: 2030, max: 2035 }),
        await ownerB.delete(`/api/wines/${wineA}/apogee`),
        await ownerB.put(`/api/wines/${wineA}/rating`).send({ rating: 15 }),
        await ownerB.delete(`/api/wines/${wineA}/rating`),
        await ownerB.post('/api/movements/out').send({ idempotencyKey: randomUUID(), wineId: wineA, quantity: 1 }),
      ]) expectNotFound(res, 'Vin introuvable');
      expectNotFound(await ownerB.post(`/api/movements/${movementA}/cancel`).send({ idempotencyKey: randomUUID() }), 'Mouvement introuvable');
      expectNotFound(await ownerB.get(`/api/photos/${photoA}/exit-candidates`), 'Photo introuvable');
      expectNotFound(
        await ownerB.post('/api/movements').send({ idempotencyKey: randomUUID(), photoId: photoA, quantity: 1, wine: draft('photo-a') }),
        'Photo introuvable',
      );
      const recent = await ownerB.get('/api/movements/recent?limit=100');
      expect(recent.status).toBe(200);
      expect(recent.body.map((m: { id: string }) => m.id)).not.toContain(movementA);
      expect(await prisma.movement.count({ where: { wine: { caveId: caveA } } })).toBe(before);
      expect(await prisma.wine.findUniqueOrThrow({ where: { id: wineA } })).toMatchObject({ apogeeMin: null, rating: null });
    });

    it('le propriétaire écrit dans sa cave : apogée, note, inventaire, entrée, lot, sortie, annulation, journal, export', async () => {
      expect((await ownerA.put(`/api/wines/${wineA}/apogee`).send({ min: 2030, max: 2035 })).status).toBe(200);
      expect((await ownerA.delete(`/api/wines/${wineA}/apogee`)).status).toBe(200);
      expect((await ownerA.put(`/api/wines/${wineA}/rating`).send({ rating: 15 })).status).toBe(200);
      expect((await ownerA.delete(`/api/wines/${wineA}/rating`)).status).toBe(200);
      expect((await ownerA.get(`/api/photos/${photoA}/exit-candidates`)).body).toEqual({ status: 'PROCESSING' });

      const inv = await ownerA.post(`/api/wines/${wineA}/inventory`).send({ idempotencyKey: randomUUID(), counted: 12 });
      expect(inv.status).toBe(201);
      expect(inv.body).toMatchObject({ stock: 12, delta: 0 });

      const entry = await ownerA.post('/api/movements').send({ idempotencyKey: randomUUID(), quantity: 2, priceUnitCents: 1500, wine: draft('entrée') });
      expect(entry.status).toBe(201);
      expect(entry.body.wine.caveId).toBe(caveA);
      expect(entry.body.movement.priceUnitCents).toBe(1500);

      const bulk = await ownerA.post('/api/movements/bulk').send([{ idempotencyKey: randomUUID(), quantity: 1, wine: draft('entrée') }]);
      expect(bulk.status).toBe(201);
      expect(bulk.body[0]).toMatchObject({ ok: true, result: { wine: { id: entry.body.wine.id }, stock: 3 } });

      const out = await ownerA.post('/api/movements/out').send({ idempotencyKey: randomUUID(), wineId: wineA, quantity: 1 });
      expect(out.status).toBe(201);
      expect(out.body.stock).toBe(11);
      const cancel = await ownerA.post(`/api/movements/${out.body.movement.id}/cancel`).send({ idempotencyKey: randomUUID() });
      expect(cancel.status).toBe(201);
      expect(cancel.body.stock).toBe(12);

      const recent = await ownerA.get('/api/movements/recent?limit=100');
      expect(recent.status).toBe(200);
      expect(recent.body.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([movementA, out.body.movement.id]));
      expect(recent.body.every((m: { wine: { caveId: string } }) => m.wine.caveId === caveA)).toBe(true);

      const xlsx = await ownerA.get('/api/export.xlsx');
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect(await prisma.exportLog.count({ where: { caveId: caveA } })).toBe(1);
    });

    it('le même vin entré par A et par B donne deux fiches', async () => {
      const a = await ownerA.post('/api/movements').send({ idempotencyKey: randomUUID(), quantity: 1, wine: draft('jumeau') });
      const b = await ownerB.post('/api/movements').send({ idempotencyKey: randomUUID(), quantity: 1, wine: draft('jumeau') });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.wine.id).not.toBe(b.body.wine.id);
      expect([a.body.wine.caveId, b.body.wine.caveId]).toEqual([caveA, caveB]);
    });
  });
});
