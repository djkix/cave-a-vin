import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppUser } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import supertest from 'supertest';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

// Photos, « À confirmer », suivi temps réel, recherche d'image, accords,
// descriptifs de domaine et qualité de lecture, en HTTP contre le vrai
// AppModule : deux caves A et B, un propriétaire de A, un membre (VIEWER) de A,
// un propriétaire de B, et un compte qui possède C et est membre de A (pour
// changer de cave courante).
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfInfra('photos, recherche d’image, accords et descriptifs par cave (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('../prisma/prisma.service').PrismaService;
  const run = randomUUID().slice(0, 8);
  const storage = mkdtempSync(join(tmpdir(), 'cave-photos-e2e-'));
  const userIds: string[] = [];
  const caveIds: string[] = [];
  let caveA: string;
  let caveB: string;
  let caveC: string;
  let wineA: string;
  let wineB: string;
  let producerKeyA: string;
  let ownerA: supertest.Agent;
  let viewerA: supertest.Agent;
  let ownerB: supertest.Agent;
  let switcher: supertest.Agent;
  let jpeg: Buffer;

  // Le message est obligatoire : sans lui, la vérification passerait à vide.
  const expectStatus = (res: supertest.Response, status: number, message: string) => {
    expect({ status: res.status, message: res.body?.message }).toEqual({ status, message });
  };

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
    const { producerKeyOf } = await import('../producers/producer-key');

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

    jpeg = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#6a1b2a' } }).jpeg().toBuffer();

    const user = async (name: string, displayName: string | null = name) => {
      const u = await prisma.appUser.create({ data: { email: `photos-${run}-${name}@example.test`, displayName } });
      userIds.push(u.id);
      return u;
    };
    const [uOwnerA, uViewerA, uOwnerB, uSwitcher] = [await user('owner-a'), await user('viewer-a'), await user('owner-b'), await user('switcher')];
    caveA = (await createTestCave(prisma, { owner: uOwnerA, name: `Photos A ${run}` })).id;
    caveB = (await createTestCave(prisma, { owner: uOwnerB, name: `Photos B ${run}` })).id;
    caveC = (await createTestCave(prisma, { owner: uSwitcher, name: `Photos C ${run}` })).id;
    caveIds.push(caveA, caveB, caveC);
    await prisma.caveMember.createMany({
      data: [
        { caveId: caveA, userId: uViewerA.id, role: 'VIEWER' },
        { caveId: caveA, userId: uSwitcher.id, role: 'VIEWER' },
      ],
    });

    const wine = (caveId: string, name: string) =>
      prisma.wine.create({ data: { caveId, matchKey: `photos-${run}-${name}`, producer: `Domaine Photos ${run} ${name}`, appellationRaw: 'Bandol', color: 'ROUGE', vintage: 2015 } });
    const a = await wine(caveA, 'a');
    wineA = a.id;
    wineB = (await wine(caveB, 'b')).id;
    producerKeyA = producerKeyOf(a.producer);
    // Descriptif écrit par un compte sans nom affiché : seul l'e-mail le désigne.
    const author = await user('auteur', null);
    await prisma.producerProfile.create({
      data: { producerKey: producerKeyA, displayName: a.producer, status: 'DONE', source: 'MANUEL', description: 'Texte', updatedById: author.id },
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
      await prisma.producerProfile.deleteMany({ where: { producerKey: producerKeyA } });
      await deleteTestCaves(prisma, caveIds);
      await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
    rmSync(storage, { recursive: true, force: true });
  });

  /** Image unie de la couleur donnée : une couleur = des octets distincts. */
  const image = (background: string) => sharp({ create: { width: 120, height: 160, channels: 3, background } }).jpeg().toBuffer();

  const upload = (agent: supertest.Agent, bytes: Buffer = jpeg) =>
    agent.post('/api/photos').attach('file', bytes, { filename: 'etiquette.jpg', contentType: 'image/jpeg' });

  /** Photo d'entrée lue (DONE), sans mouvement, rangée dans `caveId`. */
  const donePhoto = (caveId: string, name: string) =>
    prisma.photo.create({ data: { caveId, contentHash: `photos-${run}-${name}`, storagePath: 'normalized/x.jpg', status: 'DONE', purpose: 'ENTRY' } });

  describe('envoi et dédoublonnage', () => {
    it('la photo va dans la cave courante du propriétaire ; le membre reçoit 403 sans rien écrire', async () => {
      const res = await upload(ownerA);
      expect(res.status).toBe(202);
      expect(res.body.duplicate).toBe(false);
      expect((await prisma.photo.findUniqueOrThrow({ where: { id: res.body.id } })).caveId).toBe(caveA);

      const before = await prisma.photo.count({ where: { caveId: caveA } });
      const viewer = await upload(viewerA, await image('#203040'));
      expectStatus(viewer, 403, 'Lecture seule');
      expect(await prisma.photo.count({ where: { caveId: caveA } })).toBe(before);
    });

    it('les mêmes octets dans deux caves donnent deux photos ; renvoyés dans la même cave, la photo existante', async () => {
      const bytes = await image('#405060');
      const a = await upload(ownerA, bytes);
      const b = await upload(ownerB, bytes);
      const again = await upload(ownerA, bytes);
      expect([a.status, b.status, again.status]).toEqual([202, 202, 202]);
      expect([a.body.duplicate, b.body.duplicate, again.body.duplicate]).toEqual([false, false, true]);
      expect(b.body.id).not.toBe(a.body.id);
      expect(again.body.id).toBe(a.body.id);
      const rows = await prisma.photo.findMany({ where: { id: { in: [a.body.id, b.body.id] } }, select: { id: true, caveId: true } });
      expect(Object.fromEntries(rows.map((r) => [r.id, r.caveId]))).toEqual({ [a.body.id]: caveA, [b.body.id]: caveB });
    });
  });

  describe('image d’une photo', () => {
    let photoA: string;
    beforeAll(async () => {
      photoA = (await upload(ownerA, await image('#607080'))).body.id;
    });

    it('servie au propriétaire et au membre ; 404 « Photo introuvable » pour un étranger', async () => {
      for (const agent of [ownerA, viewerA]) {
        for (const path of [`/api/photos/${photoA}/image`, `/api/photos/${photoA}/image?variant=display`]) {
          const res = await agent.get(path);
          expect(res.status).toBe(200);
          expect(res.headers['content-type']).toBe('image/jpeg');
        }
      }
      expectStatus(await ownerB.get(`/api/photos/${photoA}/image`), 404, 'Photo introuvable');
      expectStatus(await ownerB.get(`/api/photos/${photoA}/image?variant=display`), 404, 'Photo introuvable');
    });

    it('reste servie après un changement de cave courante, pour toute cave du compte', async () => {
      for (const caveId of [caveA, caveC]) {
        expect((await switcher.put('/api/auth/current-cave').send({ caveId })).status).toBe(200);
        expect((await switcher.get(`/api/photos/${photoA}/image?variant=display`)).status).toBe(200);
      }
    });

    it('la ligne complète (GET photos/:id) : propriétaire dans sa cave, 403 au membre, 404 à un étranger', async () => {
      const owner = await ownerA.get(`/api/photos/${photoA}`);
      expect(owner.status).toBe(200);
      expect(owner.body).toMatchObject({ id: photoA, caveId: caveA });
      expectStatus(await viewerA.get(`/api/photos/${photoA}`), 403, 'Lecture seule');
      expectStatus(await ownerB.get(`/api/photos/${photoA}`), 404, 'Photo introuvable');
    });
  });

  describe('« À confirmer », revue groupée, file d’attente, écarter, suivi temps réel', () => {
    let doneA: string;
    let doneB: string;
    beforeAll(async () => {
      doneA = (await donePhoto(caveA, 'done-a')).id;
      doneB = (await donePhoto(caveB, 'done-b')).id;
    });

    it('chaque propriétaire ne voit que les photos de sa cave', async () => {
      const ids = (inbox: { toConfirm: { id: string }[]; inProgress: { id: string }[]; failed: { id: string }[] }) =>
        [...inbox.toConfirm, ...inbox.inProgress, ...inbox.failed].map((p) => p.id);
      const inboxA = await ownerA.get('/api/photos/entry-inbox');
      const inboxB = await ownerB.get('/api/photos/entry-inbox');
      expect(ids(inboxA.body)).toContain(doneA);
      expect(ids(inboxA.body)).not.toContain(doneB);
      expect(ids(inboxB.body)).toContain(doneB);
      expect(ids(inboxB.body)).not.toContain(doneA);

      const pendingB = await ownerB.get('/api/photos/pending-review');
      expect(pendingB.body.map((p: { id: string }) => p.id)).toEqual([doneB]);

      const rows = await prisma.photo.findMany({
        where: { caveId: caveB, status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'ENTRY', dismissedAt: null },
      });
      expect((await ownerB.get('/api/photos/queue-status')).body.waiting).toBe(rows.length);
    });

    it('le membre reçoit 403 « Lecture seule » sur chaque route de propriétaire', async () => {
      for (const res of [
        await viewerA.get('/api/photos/entry-inbox'),
        await viewerA.get('/api/photos/pending-review'),
        await viewerA.get('/api/photos/queue-status'),
        await viewerA.post(`/api/photos/${doneA}/dismiss`),
        await viewerA.get(`/api/photos/${doneA}/events`),
      ]) expectStatus(res, 403, 'Lecture seule');
      expect((await prisma.photo.findUniqueOrThrow({ where: { id: doneA } })).dismissedAt).toBeNull();
    });

    it('écarter ou suivre une photo d’une autre cave : 404 « Photo introuvable »', async () => {
      expectStatus(await ownerB.post(`/api/photos/${doneA}/dismiss`), 404, 'Photo introuvable');
      expectStatus(await ownerB.get(`/api/photos/${doneA}/events`), 404, 'Photo introuvable');
      expect((await prisma.photo.findUniqueOrThrow({ where: { id: doneA } })).dismissedAt).toBeNull();
    });

    it('suivi d’une photo de la cave : l’état, puis la fin du flux', async () => {
      const res = await ownerA.get(`/api/photos/${doneA}/events`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('"status":"DONE"');
    });

    it('le propriétaire écarte une photo de sa cave', async () => {
      expect((await ownerA.post(`/api/photos/${doneA}/dismiss`)).status).toBe(200);
      expect((await prisma.photo.findUniqueOrThrow({ where: { id: doneA } })).dismissedAt).not.toBeNull();
    });
  });

  describe('recherche d’image', () => {
    const candidateFor = (wineId: string) => {
      const id = randomUUID();
      const dir = join(storage, 'candidates');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jpg`), jpeg);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, wineId, source: 'Open Food Facts (CC BY-SA)', sourceUrl: 'https://world.openfoodfacts.org/product/1', createdAt: new Date().toISOString() }));
      return id;
    };

    it('vin d’une autre cave : 404 « Vin introuvable » ; membre : 403', async () => {
      const candidate = candidateFor(wineA);
      for (const res of [
        await ownerB.post(`/api/wines/${wineA}/image-search`),
        await ownerB.post(`/api/wines/${wineA}/reference-image`).send({ candidateId: candidate }),
        await ownerB.delete(`/api/wines/${wineA}/reference-image`),
      ]) expectStatus(res, 404, 'Vin introuvable');
      for (const res of [
        await viewerA.post(`/api/wines/${wineA}/image-search`),
        await viewerA.get(`/api/image-candidates/${candidate}`),
        await viewerA.post(`/api/wines/${wineA}/reference-image`).send({ candidateId: candidate }),
        await viewerA.delete(`/api/wines/${wineA}/reference-image`),
      ]) expectStatus(res, 403, 'Lecture seule');
      expect((await prisma.wine.findUniqueOrThrow({ where: { id: wineA } })).referencePhotoId).toBeNull();
    });

    it('une candidate n’est jamais servie ni choisie hors de la cave de son vin', async () => {
      const candidate = candidateFor(wineA);
      expectStatus(await ownerB.get(`/api/image-candidates/${candidate}`), 410, 'Proposition expirée, relancez la recherche');
      expectStatus(await ownerB.post(`/api/wines/${wineB}/reference-image`).send({ candidateId: candidate }), 410, 'Proposition expirée, relancez la recherche');
      expect((await prisma.wine.findUniqueOrThrow({ where: { id: wineB } })).referencePhotoId).toBeNull();

      const image = await ownerA.get(`/api/image-candidates/${candidate}`);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
      const chosen = await ownerA.post(`/api/wines/${wineA}/reference-image`).send({ candidateId: candidate });
      expect(chosen.status).toBe(200);
      const photo = await prisma.photo.findUniqueOrThrow({ where: { id: chosen.body.referencePhotoId } });
      expect(photo).toMatchObject({ caveId: caveA, purpose: 'REFERENCE' });
      // Vignette : lisible par le membre, introuvable pour B.
      expect((await viewerA.get(`/api/photos/${photo.id}/image?variant=display`)).status).toBe(200);
      expectStatus(await ownerB.get(`/api/photos/${photo.id}/image`), 404, 'Photo introuvable');
      expect((await ownerA.delete(`/api/wines/${wineA}/reference-image`)).status).toBe(200);
    });
  });

  describe('accords', () => {
    it('régénérer : 202 pour le propriétaire, 403 pour le membre, 404 « Vin introuvable » pour un vin d’une autre cave', async () => {
      expectStatus(await viewerA.post(`/api/wines/${wineA}/pairing/regenerate`), 403, 'Lecture seule');
      expectStatus(await ownerB.post(`/api/wines/${wineA}/pairing/regenerate`), 404, 'Vin introuvable');
      expect(await prisma.pairing.findUnique({ where: { wineId: wineA } })).toBeNull();
      expect((await ownerA.post(`/api/wines/${wineA}/pairing/regenerate`)).status).toBe(202);
      expect((await prisma.pairing.findUniqueOrThrow({ where: { wineId: wineA } })).status).toBe('PENDING');
    });
  });

  describe('descriptifs de domaine et qualité de lecture (administrateur)', () => {
    it('écrire ou régénérer un descriptif : 403 pour un compte non administrateur, même propriétaire', async () => {
      const url = (suffix: string) => `/api/producers/${encodeURIComponent(producerKeyA)}/${suffix}`;
      for (const agent of [ownerA, viewerA, ownerB]) {
        expectStatus(await agent.put(url('description')).send({ description: 'Autre texte' }), 403, 'Réservé à l’administrateur');
        expectStatus(await agent.post(url('regenerate')), 403, 'Réservé à l’administrateur');
      }
      expect(await prisma.producerProfile.findUniqueOrThrow({ where: { producerKey: producerKeyA } })).toMatchObject({ description: 'Texte', status: 'DONE' });
    });

    it('la fiche lue par le membre ne donne jamais l’e-mail de l’auteur du descriptif ; le propriétaire le voit', async () => {
      const viewer = await viewerA.get(`/api/wines/${wineA}`);
      expect(viewer.status).toBe(200);
      expect(viewer.body.wine.producerProfile).toMatchObject({ description: 'Texte', updatedBy: null });
      expect(JSON.stringify(viewer.body)).not.toContain('@example.test');
      const owner = await ownerA.get(`/api/wines/${wineA}`);
      expect(owner.body.wine.producerProfile.updatedBy).toBe(`photos-${run}-auteur@example.test`);
    });

    it('qualité de lecture : réservée à l’administrateur', async () => {
      expectStatus(await ownerA.get('/api/admin/reading-quality'), 403, 'Réservé à l’administrateur');
    });
  });
});
