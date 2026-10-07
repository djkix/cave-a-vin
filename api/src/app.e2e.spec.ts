import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo, createServer } from 'node:net';
import supertest from 'supertest';

// Ce test parle HTTP au vrai AppModule : il ne tourne que là où Postgres et Redis
// sont joignables (poste de dev, job `api` de la CI).
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfInfra('api HTTP', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let agent: supertest.Agent;
  let email: string;
  let password: string;
  let prisma: import('./prisma/prisma.service').PrismaService;

  beforeAll(async () => {
    // Doit précéder le premier loadEnv(), donc le premier import de app.module.
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.BREAK_GLASS_EMAIL ??= 'e2e@example.com';
    process.env.BREAK_GLASS_PASSWORD ??= 'e2e-break-glass-password';
    process.env.ADMIN_EMAILS ??= process.env.BREAK_GLASS_EMAIL;
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    email = process.env.BREAK_GLASS_EMAIL;
    password = process.env.BREAK_GLASS_PASSWORD;

    const { AppModule } = await import('./app.module');
    const { setupSession } = await import('./auth/session.setup');
    const { PrismaService } = await import('./prisma/prisma.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    sessionRedis = setupSession(app);
    // Écoute une fois pour toutes sur 127.0.0.1, l'adresse que supertest appelle.
    // Avec un simple `init()`, supertest ouvrait un port `::` à chaque requête ;
    // macOS peut donner un port déjà pris sur 127.0.0.1 par un autre programme,
    // qui recevait alors la requête (« socket hang up », 403…).
    await app.listen(0, '127.0.0.1');
    agent = supertest.agent(app.getHttpServer());
    prisma = app.get(PrismaService);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
  });

  it('answers the health check without a session', async () => {
    const res = await supertest(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('refuses a protected route without a session', async () => {
    const res = await supertest(app.getHttpServer()).get('/api/movements/recent');
    expect(res.status).toBe(401);
  });

  it('reaches the api, never another program listening on 127.0.0.1', async () => {
    // macOS attribue les ports éphémères à la suite : un port d'écoute qu'on vient
    // de libérer annonce le suivant. Un intrus s'installe sur 127.0.0.1 à ce port
    // et raccroche sans répondre, comme un tunnel ssh ou un autre service local.
    // Si l'api écoutait `::` à chaque requête (supertest sur un serveur arrêté),
    // macOS lui donnerait ce port quand même et la requête, envoyée à
    // 127.0.0.1, tomberait sur l'intrus : « socket hang up ».
    const intruder = createServer((socket) => socket.once('data', () => socket.end()));
    for (let attempt = 0; attempt < 5 && !intruder.listening; attempt++) {
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, r));
      const next = (probe.address() as AddressInfo).port + 1;
      await new Promise<void>((r) => probe.close(() => r()));
      await new Promise<void>((r) => {
        intruder.once('error', () => r());
        intruder.listen(next, '127.0.0.1', () => r());
      });
    }
    try {
      expect(intruder.listening).toBe(true);
      expect((await supertest(app.getHttpServer()).get('/api/movements/recent')).status).toBe(401);
    } finally {
      await new Promise<void>((r) => intruder.close(() => r()));
    }
  });

  it('opens a session with the break-glass account', async () => {
    const res = await agent.post('/api/auth/local-login').send({ email, password });
    // 201 : statut Nest par défaut pour un POST sans @HttpCode.
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email.toLowerCase());
    expect(String(res.headers['set-cookie'])).toContain('cave.sid');
  });

  it('serves /photos/pending-review as a list, not as a photo id', async () => {
    // Preuve que la route littérale gagne sur `GET /photos/:id` : un `:id` aurait
    // répondu 404 « Photo introuvable ».
    const res = await agent.get('/api/photos/pending-review');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('serves /photos/entry-inbox as three sections', async () => {
    const res = await agent.get('/api/photos/entry-inbox');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.toConfirm)).toBe(true);
    expect(Array.isArray(res.body.inProgress)).toBe(true);
    expect(Array.isArray(res.body.failed)).toBe(true);
  });

  it('refuses /photos/:id/dismiss without a session', async () => {
    const res = await supertest(app.getHttpServer()).post('/api/photos/00000000-0000-0000-0000-000000000000/dismiss');
    expect(res.status).toBe(401);
  });

  it('dismisses an entry photo without a movement, and refuses one already used', async () => {
    const free = await prisma.photo.create({
      data: { contentHash: `e2e-dismiss-free-${Date.now()}`, storagePath: 'normalized/x.jpg', status: 'DONE', purpose: 'ENTRY' },
    });
    const used = await prisma.photo.create({
      data: { contentHash: `e2e-dismiss-used-${Date.now()}`, storagePath: 'normalized/y.jpg', status: 'DONE', purpose: 'ENTRY' },
    });
    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-dismiss-${Date.now()}`, producer: 'Domaine e2e écarté', appellationRaw: 'Inconnue', color: 'ROUGE' },
    });
    const movement = await prisma.movement.create({
      data: {
        wineId: wine.id, delta: 1, type: 'IN', photoId: used.id, idempotencyKey: `e2e-dismiss-${Date.now()}`,
      },
    });
    try {
      const notFound = await agent.post('/api/photos/00000000-0000-0000-0000-000000000000/dismiss');
      expect(notFound.status).toBe(404);
      expect(notFound.body.message).toBe('Photo introuvable');

      const conflict = await agent.post(`/api/photos/${used.id}/dismiss`);
      expect(conflict.status).toBe(409);
      expect(conflict.body.message).toBe('Photo déjà utilisée par une entrée');

      const ok = await agent.post(`/api/photos/${free.id}/dismiss`);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true });
      const reloaded = await prisma.photo.findUniqueOrThrow({ where: { id: free.id } });
      expect(reloaded.dismissedAt).not.toBeNull();

      // pending-review doit refléter exactement entry-inbox.toConfirm : une photo
      // écartée ne doit réapparaître dans aucun des deux.
      const pending = await agent.get('/api/photos/pending-review');
      expect(pending.body.map((p: { id: string }) => p.id)).not.toContain(free.id);
    } finally {
      await prisma.movement.delete({ where: { id: movement.id } });
      await prisma.wine.delete({ where: { id: wine.id } });
      await prisma.photo.delete({ where: { id: free.id } });
      await prisma.photo.delete({ where: { id: used.id } });
    }
  });

  it('downloads the Excel workbook as an attachment', async () => {
    const res = await agent.get('/api/export.xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="cave-\d{4}-\d{2}-\d{2}\.xlsx"/);
  });

  it('lists accounts for the break-glass admin (ADMIN_EMAILS makes it administrator), never leaking passwordHash or googleSub', async () => {
    const res = await agent.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('googleSub');
  });

  it('lets an admin qualify a vintage, then return it to « non qualifié »', async () => {
    const put = await agent.put('/api/admin/vintages').send({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    expect(put.status).toBe(200);
    const list = await agent.get('/api/admin/vintages');
    expect(list.body.regions).toContain('Rhône');
    expect(list.body.qualities).toContainEqual({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    const del = await agent.delete(`/api/admin/vintages/${encodeURIComponent('Rhône')}/2016`);
    expect(del.status).toBe(204);
  });

  it('answers in French when the vintage year or guard id is not well-formed', async () => {
    const badYear = await agent.delete(`/api/admin/vintages/${encodeURIComponent('Rhône')}/abc`);
    expect(badYear.status).toBe(400);
    expect(badYear.body.message).toBe('Année invalide');
    const badId = await agent.delete('/api/admin/guards/not-a-uuid');
    expect(badId.status).toBe(400);
    expect(badId.body.message).toBe('Identifiant d’ajustement invalide');
    const badQuery = await agent.get('/api/admin/guards?q=a&q=b');
    expect(badQuery.status).toBe(400);
  });

  it('lets a wine owner correct, then clear, its own apogee over HTTP', async () => {
    const appellation = await prisma.appellation.findFirstOrThrow({ where: { canonicalName: 'Châteauneuf-du-Pape' } });
    const wine = await prisma.wine.create({
      data: {
        matchKey: `e2e-apogee-${Date.now()}`,
        producer: 'Domaine e2e',
        appellationId: appellation.id,
        appellationRaw: appellation.canonicalName,
        vintage: 2016,
        color: 'ROUGE',
      },
    });
    try {
      const ok = await agent.put(`/api/wines/${wine.id}/apogee`).send({ min: 2030, max: 2035 });
      expect(ok.status).toBe(200);
      expect(ok.body.confidence).toBe('SAISIE');
      const invalid = await agent.put(`/api/wines/${wine.id}/apogee`).send({ min: 2035, max: 2030 });
      expect(invalid.status).toBe(400);
      expect(invalid.body.message).toBe('L’année de début doit précéder ou égaler l’année de fin');
      const cleared = await agent.delete(`/api/wines/${wine.id}/apogee`);
      expect(cleared.status).toBe(200);
      expect(cleared.body.source).toBe('REGLE');
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('filters the cave on « à boire en priorité » and « sans apogée »', async () => {
    const wine = await prisma.wine.create({
      data: {
        matchKey: `e2e-drink-soon-${Date.now()}`, producer: 'Domaine e2e priorité', appellationRaw: 'Inconnue',
        vintage: null, color: 'ROUGE', apogeeMin: 2000, apogeeMax: 2001, apogeeSource: 'MANUEL',
      },
    });
    try {
      const soon = await agent.get('/api/cave?drinkSoon=true&includeEmpty=true');
      expect(soon.status).toBe(200);
      expect(soon.body.map((w: { id: string }) => w.id)).toContain(wine.id);
      const none = await agent.get('/api/cave?noApogee=true&includeEmpty=true');
      expect(none.body.map((w: { id: string }) => w.id)).not.toContain(wine.id);
      const both = await agent.get('/api/cave?drinkSoon=true&noApogee=true');
      expect(both.status).toBe(400);
      expect(both.body.message).toBe('Choisis « à boire en priorité » ou « sans apogée », pas les deux');
      const badExport = await agent.get('/api/export.xlsx?drinkSoon=oui');
      expect(badExport.status).toBe(400);
      expect(badExport.body.message).toBe('Filtre d’export invalide');
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('measures « zéro saisie » from photo entries for an admin', async () => {
    const photo = await prisma.photo.create({
      data: {
        contentHash: `e2e-zero-${Date.now()}`, storagePath: 'normalized/x.jpg', status: 'DONE',
        rawExtraction: {
          producteur: { value: 'Domaine e2e lecture', confidence: 0.9 }, cuvee: { value: null, confidence: 0 },
          appellation: { value: 'Bandol', confidence: 0.9 }, millesime: { value: 2019, confidence: 0.9 },
          couleur: { value: 'rouge', confidence: 0.9 }, format_cl: { value: 75, confidence: 0.9 }, degre: { value: null, confidence: 0 },
          pays_region: { value: null, confidence: 0 }, nb_cols_carton: { value: null, confidence: 0 }, confiance_globale: 0.9,
        },
      },
    });
    const before = (await agent.get('/api/admin/reading-quality')).body;
    const res = await agent.post('/api/movements').send({
      idempotencyKey: crypto.randomUUID(), photoId: photo.id, quantity: 1,
      wine: { producer: 'Domaine e2e lecture', appellationRaw: 'Bandol', vintage: 2018, color: 'ROUGE', formatCl: 75 },
    });
    expect(res.status).toBe(201);
    try {
      const after = await agent.get('/api/admin/reading-quality');
      expect(after.status).toBe(200);
      expect(after.body.days).toBe(90);
      expect(after.body.entries).toBe(before.entries + 1);
      const vintage = (b: { fields: { field: string; corrected: number }[] }) => b.fields.find((f) => f.field === 'vintage')!.corrected;
      expect(vintage(after.body)).toBe(vintage(before) + 1);
    } finally {
      await prisma.movement.deleteMany({ where: { wineId: res.body.wine.id } });
      await prisma.wine.delete({ where: { id: res.body.wine.id } });
      await prisma.photo.delete({ where: { id: photo.id } });
    }
  });

  it('serves the cave statistics to a signed-in account, never without a session', async () => {
    const res = await agent.get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      bottles: expect.any(Number), references: expect.any(Number), pricedReferences: expect.any(Number),
      byColor: expect.any(Array), byRegion: expect.any(Array), byDecade: expect.any(Array), byApogee: expect.any(Array),
      drinkRate: expect.any(Number), mostDrunk: expect.any(Array), topProducers: expect.any(Array), mostExpensive: expect.any(Array),
    }));
    expect(res.body.months).toHaveLength(12);
    expect((await supertest(app.getHttpServer()).get('/api/stats')).status).toBe(401);
  });

  it('lets a signed-in account rate a wine, then remove the rating', async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-rating-${Date.now()}`, producer: 'Domaine e2e note', appellationRaw: 'Bandol', color: 'ROUGE' },
    });
    try {
      const ok = await agent.put(`/api/wines/${wine.id}/rating`).send({ rating: 16.5 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ value: 16.5, ratedBy: expect.any(String) });
      const detail = await agent.get(`/api/wines/${wine.id}`);
      expect(detail.body.wine.rating.value).toBe(16.5);
      const bad = await agent.put(`/api/wines/${wine.id}/rating`).send({ rating: 16.3 });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe('La note se donne par demi-point');
      const cleared = await agent.delete(`/api/wines/${wine.id}/rating`);
      expect(cleared.status).toBe(200);
      expect((await agent.get(`/api/wines/${wine.id}`)).body.wine.rating).toBeNull();
      expect((await supertest(app.getHttpServer()).put(`/api/wines/${wine.id}/rating`).send({ rating: 12 })).status).toBe(401);
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('queues a pairing regeneration for a known wine, 404 otherwise', async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-pairing-${Date.now()}`, producer: 'Domaine e2e accords', appellationRaw: 'Bandol', color: 'ROUGE' },
    });
    try {
      const res = await agent.post(`/api/wines/${wine.id}/pairing/regenerate`);
      expect(res.status).toBe(202);
      expect((await prisma.pairing.findUniqueOrThrow({ where: { wineId: wine.id } })).status).toBe('PENDING');
      expect((await agent.get(`/api/wines/${wine.id}`)).body.wine.pairing).toMatchObject({ status: 'PENDING', dishes: [] });
      expect((await agent.post('/api/wines/00000000-0000-4000-8000-000000000000/pairing/regenerate')).status).toBe(404);
      expect((await supertest(app.getHttpServer()).post(`/api/wines/${wine.id}/pairing/regenerate`)).status).toBe(401);
      await prisma.pairing.update({ where: { wineId: wine.id }, data: { status: 'DONE', dishes: ['Agneau de sept heures'] } });
      const found = await agent.get('/api/cave?dish=AGNEAU&includeEmpty=true');
      expect(found.status).toBe(200);
      expect(found.body.find((w: { id: string }) => w.id === wine.id)?.matchedDish).toBe('Agneau de sept heures');
      expect((await agent.get(`/api/cave?dish=${'x'.repeat(101)}`)).status).toBe(400);
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('saves a hand-written producer description, shows it on the wine, and regenerates it', async () => {
    const { producerKeyOf } = await import('./producers/producer-key');
    const producer = `Domaine e2e Descriptif ${Date.now()}`;
    const key = producerKeyOf(producer);
    const url = (suffix: string) => `/api/producers/${encodeURIComponent(key)}/${suffix}`;
    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-producer-${Date.now()}`, producer, appellationRaw: 'Bandol', color: 'ROUGE' },
    });
    try {
      const before = (await agent.get(`/api/wines/${wine.id}`)).body.wine;
      expect(before.producerKey).toBe(key);
      expect(before.producerProfile).toBeNull();

      const anonymous = supertest(app.getHttpServer());
      expect((await anonymous.put(url('description')).send({ description: 'Texte' })).status).toBe(401);
      expect((await anonymous.post(url('regenerate'))).status).toBe(401);

      const tooLong = await agent.put(url('description')).send({ description: 'x'.repeat(2001) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.message).toBe('Le descriptif doit faire entre 1 et 2000 caractères');

      const saved = await agent.put(url('description')).send({ description: '  Un domaine de Bandol, écrit à la main.  ' });
      expect(saved.status).toBe(200);
      const detail = await agent.get(`/api/wines/${wine.id}`);
      expect(detail.body.wine.producerProfile).toMatchObject({
        key, displayName: producer, status: 'DONE', description: 'Un domaine de Bandol, écrit à la main.', source: 'MANUEL',
        errorMessage: null, updatedBy: expect.any(String),
      });

      const regen = await agent.post(url('regenerate'));
      expect(regen.status).toBe(202);
      expect((await agent.get(`/api/wines/${wine.id}`)).body.wine.producerProfile).toMatchObject({
        status: 'PENDING', source: 'GEMINI', description: null, updatedBy: null,
      });

      const missing = await agent.post(`/api/producers/${encodeURIComponent('domaine inexistant e2e')}/regenerate`);
      expect(missing.status).toBe(404);
      expect(missing.body.message).toBe('Domaine introuvable');
      expect((await agent.put(`/api/producers/${encodeURIComponent('domaine inexistant e2e')}/description`).send({ description: 'Texte' })).status).toBe(404);
    } finally {
      await prisma.producerProfile.deleteMany({ where: { producerKey: key } });
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('refuses the image search routes without a session', async () => {
    const server = supertest(app.getHttpServer());
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await server.post(`/api/wines/${id}/image-search`)).status).toBe(401);
    expect((await server.get(`/api/image-candidates/${id}`)).status).toBe(401);
    expect((await server.post(`/api/wines/${id}/reference-image`).send({ candidateId: id })).status).toBe(401);
    expect((await server.delete(`/api/wines/${id}/reference-image`)).status).toBe(401);
  });

  it('answers 404 « Vin introuvable », 410 for an unknown candidate and 400 for a malformed choice', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const res of [
      await agent.post(`/api/wines/${unknown}/image-search`),
      await agent.post(`/api/wines/${unknown}/reference-image`).send({ candidateId: unknown }),
      await agent.delete(`/api/wines/${unknown}/reference-image`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Vin introuvable');
    }
    const gone = await agent.get(`/api/image-candidates/${unknown}`);
    expect(gone.status).toBe(410);
    expect(gone.body.message).toBe('Proposition expirée, relancez la recherche');

    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-reference-${Date.now()}`, producer: 'Domaine e2e image', appellationRaw: 'Inconnue', color: 'ROUGE' },
    });
    try {
      const bad = await agent.post(`/api/wines/${wine.id}/reference-image`).send({ candidateId: 'pas-un-uuid' });
      expect(bad.status).toBe(400);
      const expired = await agent.post(`/api/wines/${wine.id}/reference-image`).send({ candidateId: unknown });
      expect(expired.status).toBe(410);
      const revert = await agent.delete(`/api/wines/${wine.id}/reference-image`);
      expect(revert.status).toBe(200);
      expect(revert.body).toEqual({ referencePhotoId: null, referencePhotoSource: null, referencePhotoSourceUrl: null });
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('exposes the source of a web image on the wine detail', async () => {
    const wine = await prisma.wine.create({
      data: {
        matchKey: `e2e-reference-source-${Date.now()}`, producer: 'Domaine e2e source', appellationRaw: 'Inconnue', color: 'ROUGE',
        referencePhotoSource: 'Open Food Facts (CC BY-SA)', referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1',
      },
    });
    try {
      const res = await agent.get(`/api/wines/${wine.id}`);
      expect(res.status).toBe(200);
      expect(res.body.wine.referencePhotoSource).toBe('Open Food Facts (CC BY-SA)');
      expect(res.body.wine.referencePhotoSourceUrl).toBe('https://world.openfoodfacts.org/product/1');
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });

  it('refuses the admin listing without a session', async () => {
    const res = await supertest(app.getHttpServer()).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('refuses the admin listing to an authenticated but non-admin account', async () => {
    // ADMIN_EMAILS reste un plancher garanti : ce flip direct en base simule un
    // compte que l'environnement ne couvre pas (contrairement au compte de
    // secours), sans passer par une vraie promotion/rétrogradation.
    await prisma.$executeRaw`UPDATE app_user SET is_admin = false WHERE email = ${email.toLowerCase()}`;
    const res = await agent.get('/api/admin/users');
    expect(res.status).toBe(403);
  });

  it('refuses the apogee rules to an authenticated but non-admin account', async () => {
    expect((await agent.put('/api/admin/vintages').send({ region: 'Rhône', year: 2016, quality: 'GRAND' })).status).toBe(403);
    expect((await agent.get('/api/admin/guards?q=bandol')).status).toBe(403);
    expect((await agent.get('/api/admin/reading-quality')).status).toBe(403);
  });

  // Garder ce cas en dernier : il épuise le quota de connexion locale.
  it('rate-limits brute force on the break-glass login', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await supertest(app.getHttpServer()).post('/api/auth/local-login').send({ email, password: 'mauvais-mot-de-passe' });
      last = res.status;
    }
    expect(last).toBe(429);
  }, 30_000);
});
