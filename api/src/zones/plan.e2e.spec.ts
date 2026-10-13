import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppUser } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import supertest from 'supertest';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';
import { CavePlanController } from './plan.controller';

// Plan de la cave et repères des zones, en HTTP contre le vrai AppModule : un
// propriétaire de A, un membre (VIEWER) de A, un propriétaire de B, et un compte
// qui possède C et est membre de A (image lue hors de la cave courante).
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

interface Zone { id: string; name: string; marker: { x: number; y: number } | null }
interface PlanRead { plan: { width: number; height: number; updatedAt: string } | null; markers: Array<{ zoneId: string; name: string; number: number; x: number; y: number }> }

describeIfInfra('plan de la cave (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('../prisma/prisma.service').PrismaService;
  const run = randomUUID().slice(0, 8);
  const storage = mkdtempSync(join(tmpdir(), 'cave-plan-e2e-'));
  const userIds: string[] = [];
  const caveIds: string[] = [];
  let caveA: string;
  let caveC: string;
  let ownerA: supertest.Agent;
  let viewerA: supertest.Agent;
  let ownerB: supertest.Agent;
  let switcher: supertest.Agent;

  const expectStatus = (res: supertest.Response, status: number, message: string) => {
    expect({ status: res.status, message: res.body?.message }).toEqual({ status, message });
  };
  const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#c0b0a0' } }).png().toBuffer();
  const upload = (file: Buffer, agent: supertest.Agent = ownerA, contentType = 'image/png') =>
    agent.put('/api/caves/current/plan').attach('file', file, { filename: 'plan.png', contentType });
  const read = async (agent: supertest.Agent = ownerA): Promise<PlanRead> => {
    const res = await agent.get('/api/caves/current/plan');
    expect(res.status).toBe(200);
    return res.body;
  };
  const zones = async (agent: supertest.Agent = ownerA): Promise<Zone[]> => (await agent.get('/api/caves/current/zones')).body;
  const newZone = async (name: string): Promise<Zone> => {
    const res = await ownerA.post('/api/caves/current/zones').send({ name });
    expect(res.status).toBe(201);
    return res.body;
  };
  const mark = (id: string, body: unknown, agent: supertest.Agent = ownerA) => agent.put(`/api/caves/current/zones/${id}/marker`).send(body as object);
  const planFile = () => join(storage, 'plans', `${caveA}.jpg`);

  beforeAll(async () => {
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    process.env.PHOTO_STORAGE_DIR = storage;
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
      const u = await prisma.appUser.create({ data: { email: `plan-${run}-${name}@example.test`, displayName: name } });
      userIds.push(u.id);
      return u;
    };
    const [uOwnerA, uViewerA, uOwnerB, uSwitcher] = [await user('owner-a'), await user('viewer-a'), await user('owner-b'), await user('switcher')];
    caveA = (await createTestCave(prisma, { owner: uOwnerA, name: `Plan A ${run}` })).id;
    const caveB = (await createTestCave(prisma, { owner: uOwnerB, name: `Plan B ${run}` })).id;
    caveC = (await createTestCave(prisma, { owner: uSwitcher, name: `Plan C ${run}` })).id;
    caveIds.push(caveA, caveB, caveC);
    await prisma.caveMember.createMany({
      data: [
        { caveId: caveA, userId: uViewerA.id, role: 'VIEWER' },
        { caveId: caveA, userId: uSwitcher.id, role: 'VIEWER' },
      ],
    });
    const signedIn = async (u: AppUser) => {
      const agent = supertest.agent(app.getHttpServer());
      expect((await agent.get(`/__test/login?id=${u.id}`)).status).toBe(204);
      return agent;
    };
    [ownerA, viewerA, ownerB, switcher] = [await signedIn(uOwnerA), await signedIn(uViewerA), await signedIn(uOwnerB), await signedIn(uSwitcher)];
  }, 120_000);

  afterAll(async () => {
    if (prisma && caveIds.length) {
      await deleteTestCaves(prisma, caveIds);
      await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
    rmSync(storage, { recursive: true, force: true });
  });

  // Les tests s'enchaînent : sans plan, envoi, repères, retrait.
  let z1: Zone;
  let z2: Zone;
  let z3: Zone;

  it('sans plan : rien à lire, et aucun repère ne se pose (409 « Ajoutez d\'abord un plan de la cave »)', async () => {
    [z1, z2, z3] = [await newZone(`Cave 1 ${run}`), await newZone(`Garage ${run}`), await newZone(`Cellier ${run}`)];
    expect(await read()).toEqual({ plan: null, markers: [] });
    expect(await read(viewerA)).toEqual({ plan: null, markers: [] });
    expectStatus(await mark(z1.id, { x: 0.5, y: 0.5 }), 409, 'Ajoutez d\'abord un plan de la cave');
    expect((await zones()).map((z) => z.marker)).toEqual([null, null, null]);
    expectStatus(await ownerA.get(`/api/caves/plans/${caveA}/image`), 404, 'Plan introuvable');
  });

  describe('envoi du plan', () => {
    it('est limité comme celui d’une photo (ThrottlerGuard)', () => {
      const guards: unknown[] = Reflect.getMetadata('__guards__', CavePlanController.prototype.setPlan) ?? [];
      expect(guards).toContain(ThrottlerGuard);
    });

    it('le propriétaire l’envoie : JPEG de 2400 px au plus sur le grand côté, taille et date rendues ; le membre ne peut pas', async () => {
      const big = await png(4800, 2400);
      expectStatus(await upload(big, viewerA), 403, 'Lecture seule');
      expect(existsSync(planFile())).toBe(false);
      const res = await upload(big);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ width: 2400, height: 1200, updatedAt: expect.any(String) });
      expect(await sharp(planFile()).metadata()).toMatchObject({ format: 'jpeg', width: 2400, height: 1200 });
      expect((await read(viewerA)).plan).toEqual(res.body);
      // Aucun fichier temporaire ne reste à côté du plan.
      expect(readdirSync(join(storage, 'plans'))).toEqual([`${caveA}.jpg`]);
    });

    it('redresse une photo selon son orientation EXIF (taille rendue redressée) et remplace le plan précédent', async () => {
      const before = (await read()).plan!;
      const portrait = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#203040' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
      const res = await upload(portrait, ownerA, 'image/jpeg');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ width: 800, height: 2400 });
      expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
      expect(await sharp(planFile()).metadata()).toMatchObject({ width: 800, height: 2400 });
      expect(readdirSync(join(storage, 'plans'))).toEqual([`${caveA}.jpg`]);
    });

    it('400 sans fichier, format refusé ou image illisible ; 413 au-delà de 15 Mo ; le plan en place ne change pas', async () => {
      const before = await read();
      expectStatus(await ownerA.put('/api/caves/current/plan'), 400, 'Fichier « file » manquant');
      expectStatus(await upload(Buffer.from('x'), ownerA, 'image/gif'), 400, 'Format d’image non pris en charge');
      expectStatus(await upload(Buffer.from('pas une image'), ownerA, 'image/jpeg'), 400, 'Image illisible ou format non pris en charge');
      expectStatus(await upload(Buffer.alloc(15 * 1024 * 1024 + 1), ownerA, 'image/jpeg'), 413, 'Photo trop lourde (15 Mo au plus)');
      expect(await read()).toEqual(before);
      expect(readdirSync(join(storage, 'plans'))).toEqual([`${caveA}.jpg`]);
    });

    it('envois simultanés : un seul plan, complet, celui qu’enregistre la base', async () => {
      const [a, b] = await Promise.all([upload(await png(1000, 500)), upload(await png(500, 1000))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const { plan } = await read();
      expect(await sharp(planFile()).metadata()).toMatchObject({ width: plan!.width, height: plan!.height });
      expect(readdirSync(join(storage, 'plans'))).toEqual([`${caveA}.jpg`]);
    });
  });

  describe('image du plan', () => {
    it('lue par tout membre de la cave, même hors de sa cave courante ; 404 « Plan introuvable » pour un étranger', async () => {
      for (const agent of [ownerA, viewerA]) {
        const img = await agent.get(`/api/caves/plans/${caveA}/image`);
        expect(img.status).toBe(200);
        expect(img.headers['content-type']).toBe('image/jpeg');
        expect(img.headers['cache-control']).toBe('private, no-cache');
        expect(img.headers.etag).toEqual(expect.any(String));
      }
      for (const caveId of [caveA, caveC]) {
        expect((await switcher.put('/api/auth/current-cave').send({ caveId })).status).toBe(200);
        expect((await switcher.get(`/api/caves/plans/${caveA}/image`)).status).toBe(200);
      }
      expectStatus(await ownerB.get(`/api/caves/plans/${caveA}/image`), 404, 'Plan introuvable');
      expectStatus(await ownerA.get(`/api/caves/plans/${randomUUID()}/image`), 404, 'Plan introuvable');
      expectStatus(await ownerA.get('/api/caves/plans/pas-un-uuid/image'), 404, 'Plan introuvable');
      // Cave sans plan.
      expectStatus(await switcher.get(`/api/caves/plans/${caveC}/image`), 404, 'Plan introuvable');
    });
  });

  describe('repères', () => {
    it('le propriétaire pose et déplace un repère ; la zone le porte (liste des zones comprise)', async () => {
      const res = await mark(z3.id, { x: 0.25, y: 0.75 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: z3.id, marker: { x: 0.25, y: 0.75 } });
      expect((await mark(z3.id, { x: 0, y: 1 })).body.marker).toEqual({ x: 0, y: 1 });
      expect((await zones(viewerA)).find((z) => z.id === z3.id)?.marker).toEqual({ x: 0, y: 1 });
      expect((await zones()).find((z) => z.id === z1.id)?.marker).toBeNull();
      expectStatus(await mark(z3.id, { x: 0.5, y: 0.5 }, viewerA), 403, 'Lecture seule');
      expectStatus(await viewerA.delete(`/api/caves/current/zones/${z3.id}/marker`), 403, 'Lecture seule');
    });

    it.each([
      [{ x: 1.5, y: 0.5 }], [{ x: -0.1, y: 0.5 }], [{ x: 0.5 }], [{ x: '0.5', y: 0.5 }], [{ x: null, y: null }], [{}], [{ x: 0.5, y: 2 }],
    ])('400 « Position invalide sur le plan » : %j', async (body) => {
      expectStatus(await mark(z1.id, body), 400, 'Position invalide sur le plan');
      expect((await zones()).find((z) => z.id === z1.id)?.marker).toBeNull();
    });

    it('404 « Zone introuvable » : zone d’une autre cave, inconnue ou archivée', async () => {
      expectStatus(await mark(z1.id, { x: 0.5, y: 0.5 }, ownerB), 404, 'Zone introuvable');
      expectStatus(await ownerB.delete(`/api/caves/current/zones/${z3.id}/marker`), 404, 'Zone introuvable');
      expectStatus(await mark(randomUUID(), { x: 0.5, y: 0.5 }), 404, 'Zone introuvable');
      expectStatus(await mark('pas-un-uuid', { x: 0.5, y: 0.5 }), 404, 'Zone introuvable');
      const archived = await newZone(`Archivée ${run}`);
      await prisma.caveZone.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
      expectStatus(await mark(archived.id, { x: 0.5, y: 0.5 }), 404, 'Zone introuvable');
      expectStatus(await ownerA.delete(`/api/caves/current/zones/${archived.id}/marker`), 404, 'Zone introuvable');
      expect((await prisma.caveZone.findFirstOrThrow({ where: { caveId: caveIds[1] } }).catch(() => null))).toBeNull();
    });

    it('numérotés de 1 en 1 dans l’ordre d’affichage des zones, parmi celles qui ont un repère ; lisibles par le membre', async () => {
      expect((await mark(z1.id, { x: 0.1, y: 0.2 })).status).toBe(200);
      const { markers } = await read(viewerA);
      expect(markers).toEqual([
        { zoneId: z1.id, name: z1.name, number: 1, x: 0.1, y: 0.2 },
        { zoneId: z3.id, name: z3.name, number: 2, x: 0, y: 1 },
      ]);
      // Nouvel ordre : Cellier, Garage, Cave 1 → Cellier devient 1.
      expect((await ownerA.post('/api/caves/current/zones/order').send({ ids: [z3.id, z2.id, z1.id] })).status).toBe(200);
      expect((await read()).markers.map((m) => [m.zoneId, m.number])).toEqual([[z3.id, 1], [z1.id, 2]]);
    });

    it('une zone archivée garde son repère en base mais n’apparaît jamais sur le plan', async () => {
      const z = await newZone(`Éphémère ${run}`);
      expect((await mark(z.id, { x: 0.9, y: 0.9 })).status).toBe(200);
      expect((await read()).markers.map((m) => m.zoneId)).toContain(z.id);
      // Une entrée puis une sortie : la zone a servi, « Supprimer » l'archive.
      const entry = await ownerA.post('/api/movements').send({
        idempotencyKey: randomUUID(), quantity: 1, location: { zoneId: z.id },
        wine: { producer: `Domaine Plan ${run}`, appellationRaw: 'Bandol', vintage: 2015, color: 'ROUGE', formatCl: 75 },
      });
      expect(entry.status).toBe(201);
      const [place] = (await ownerA.get(`/api/wines/${entry.body.wine.id}`)).body.locations;
      expect((await ownerA.post('/api/movements/out').send({ idempotencyKey: randomUUID(), wineId: entry.body.wine.id, quantity: 1, locationId: place.id })).status).toBe(201);
      expect((await ownerA.delete(`/api/caves/current/zones/${z.id}`)).body).toEqual({ archived: true });
      expect(await prisma.caveZone.findUniqueOrThrow({ where: { id: z.id } })).toMatchObject({ planX: 0.9, planY: 0.9 });
      const { markers } = await read();
      expect(markers.map((m) => m.zoneId)).toEqual([z3.id, z1.id]);
      expect(markers.map((m) => m.number)).toEqual([1, 2]);
    });

    it('retirer un repère : la zone n’en a plus, les numéros se resserrent', async () => {
      const res = await ownerA.delete(`/api/caves/current/zones/${z3.id}/marker`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: z3.id, marker: null });
      expect((await read()).markers).toEqual([{ zoneId: z1.id, name: z1.name, number: 1, x: 0.1, y: 0.2 }]);
      expect(await prisma.caveZone.findUniqueOrThrow({ where: { id: z3.id } })).toMatchObject({ planX: null, planY: null });
    });
  });

  describe('retirer le plan', () => {
    it('le membre ne peut pas ; le propriétaire retire le fichier et le plan, les repères sont gardés', async () => {
      expectStatus(await viewerA.delete('/api/caves/current/plan'), 403, 'Lecture seule');
      expect(existsSync(planFile())).toBe(true);
      const res = await ownerA.delete('/api/caves/current/plan');
      expect(res.status).toBe(204);
      expect(existsSync(planFile())).toBe(false);
      expect(await read(viewerA)).toEqual({ plan: null, markers: [] });
      expectStatus(await viewerA.get(`/api/caves/plans/${caveA}/image`), 404, 'Plan introuvable');
      expect(await prisma.cave.findUniqueOrThrow({ where: { id: caveA } })).toMatchObject({ planPath: null, planWidth: null, planHeight: null, planUpdatedAt: null });
      // Repère gardé : il revient avec un plan équivalent.
      expect((await zones()).find((z) => z.id === z1.id)?.marker).toEqual({ x: 0.1, y: 0.2 });
      expectStatus(await mark(z2.id, { x: 0.5, y: 0.5 }), 409, 'Ajoutez d\'abord un plan de la cave');
      // Retirer un repère reste possible sans plan ; retirer un plan absent ne fait rien.
      expect((await ownerA.delete('/api/caves/current/plan')).status).toBe(204);
      expect((await upload(await png(600, 300))).status).toBe(200);
      expect((await read()).markers).toEqual([{ zoneId: z1.id, name: z1.name, number: 1, x: 0.1, y: 0.2 }]);
    });
  });
});
