import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppUser, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

// Comptes, inscriptions et cave courante, en HTTP contre le vrai AppModule.
// La connexion Google n'est pas rejouable ici : une route de test, montée par
// ce seul fichier, ouvre la session d'un compte créé en base.
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfInfra('comptes, inscriptions et cave courante (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('../prisma/prisma.service').PrismaService;
  const userIds: string[] = [];
  const caveIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    // Pas de compte de secours ici : l'autre suite HTTP le crée déjà.
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
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      const owned = await prisma.cave.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
      await deleteTestCaves(prisma, [...caveIds, ...owned.map((c) => c.id)]);
      try {
        await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
      } catch (e) {
        // Une cave gardée (encore des lignes) retient son propriétaire.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError)) throw e;
      }
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
  });

  async function user(data: Partial<Prisma.AppUserCreateInput> = {}): Promise<AppUser> {
    const u = await prisma.appUser.create({ data: { email: `acc-${run}-${randomUUID().slice(0, 8)}@example.test`, ...data } });
    userIds.push(u.id);
    return u;
  }
  async function cave(name: string, owner?: { id: string }) {
    const c = await createTestCave(prisma, { name: `${name} ${run}`, owner });
    caveIds.push(c.id);
    return c;
  }
  async function signedIn(u: AppUser) {
    const agent = supertest.agent(app.getHttpServer());
    expect((await agent.get(`/__test/login?id=${u.id}`)).status).toBe(204);
    return agent;
  }

  describe('compte en attente', () => {
    it('voit son statut sur /auth/me, sans cave', async () => {
      const agent = await signedIn(await user({ status: 'PENDING', displayName: 'Pierre' }));
      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ status: 'PENDING', caves: [], currentCaveId: null, isAdmin: false, displayName: 'Pierre' });
    });

    it('est refusé partout ailleurs (403 « Inscription en attente de validation »), sauf santé et déconnexion', async () => {
      const agent = await signedIn(await user({ status: 'PENDING' }));
      for (const res of [
        await agent.get('/api/stats'),
        await agent.get('/api/cave'),
        await agent.get('/api/admin/users'),
        await agent.put('/api/auth/current-cave').send({ caveId: randomUUID() }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('Inscription en attente de validation');
      }
      expect((await agent.get('/api/health')).status).toBe(200);
      expect((await agent.post('/api/auth/logout')).status).toBe(201);
      expect((await agent.get('/api/auth/me')).status).toBe(401);
    });
  });

  describe('cave courante', () => {
    it('/auth/me liste ses caves (la sienne d’abord) et part de sa cave OWNER', async () => {
      const me = await user();
      const other = await user();
      const mine = await cave('Zèbre', me);
      const shared = await cave('Alsace', other);
      await prisma.caveMember.create({ data: { caveId: shared.id, userId: me.id, role: 'VIEWER' } });
      const agent = await signedIn(me);

      const res = await agent.get('/api/auth/me');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: me.id, email: me.email, status: 'ACTIVE', currentCaveId: mine.id });
      expect(res.body.caves).toEqual([
        { id: mine.id, name: mine.name, role: 'OWNER' },
        { id: shared.id, name: shared.name, role: 'VIEWER' },
      ]);
    });

    it('PUT /auth/current-cave change la cave courante, 404 « Cave introuvable » si elle n’est pas accessible', async () => {
      const me = await user();
      const other = await user();
      const mine = await cave('À moi', me);
      const shared = await cave('Partagée', other);
      const foreign = await cave('Étrangère', other);
      const membership = await prisma.caveMember.create({ data: { caveId: shared.id, userId: me.id, role: 'VIEWER' } });
      const agent = await signedIn(me);

      const put = await agent.put('/api/auth/current-cave').send({ caveId: shared.id });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ id: me.id, currentCaveId: shared.id, caves: expect.any(Array) });
      expect((await agent.get('/api/auth/me')).body.currentCaveId).toBe(shared.id);

      for (const caveId of [foreign.id, randomUUID()]) {
        const refused = await agent.put('/api/auth/current-cave').send({ caveId });
        expect(refused.status).toBe(404);
        expect(refused.body.message).toBe('Cave introuvable');
      }
      expect((await agent.put('/api/auth/current-cave').send({})).status).toBe(400);
      expect((await agent.get('/api/auth/me')).body.currentCaveId).toBe(shared.id);

      // Retiré de la cave choisie : retour à sa propre cave.
      await prisma.caveMember.delete({ where: { id: membership.id } });
      expect((await agent.get('/api/auth/me')).body.currentCaveId).toBe(mine.id);
    });

    it('sans cave à lui, part de la plus ancienne invitation', async () => {
      const me = await user();
      const other = await user();
      const recent = await cave('Récente', other);
      const old = await cave('Ancienne', other);
      await prisma.caveMember.create({ data: { caveId: recent.id, userId: me.id, role: 'VIEWER', createdAt: new Date('2026-02-01T00:00:00Z') } });
      await prisma.caveMember.create({ data: { caveId: old.id, userId: me.id, role: 'VIEWER', createdAt: new Date('2026-01-01T00:00:00Z') } });
      const res = await (await signedIn(me)).get('/api/auth/me');
      expect(res.body.currentCaveId).toBe(old.id);
    });

    it('refuse sans session', async () => {
      expect((await supertest(app.getHttpServer()).put('/api/auth/current-cave').send({ caveId: randomUUID() })).status).toBe(401);
    });
  });

  describe('administration des inscriptions', () => {
    it('liste les comptes en attente, du plus ancien au plus récent, réservée à un administrateur', async () => {
      const admin = await signedIn(await user({ isAdmin: true }));
      const first = await user({ status: 'PENDING', displayName: 'Premier', createdAt: new Date('2026-01-01T00:00:00Z') });
      const second = await user({ status: 'PENDING', createdAt: new Date('2026-01-02T00:00:00Z') });
      await user({ status: 'ACTIVE' });

      const res = await admin.get('/api/admin/registrations');
      expect(res.status).toBe(200);
      const ours = res.body.filter((r: { id: string }) => r.id === first.id || r.id === second.id);
      expect(ours).toEqual([
        { id: first.id, email: first.email, displayName: 'Premier', createdAt: first.createdAt.toISOString() },
        { id: second.id, email: second.email, displayName: null, createdAt: second.createdAt.toISOString() },
      ]);
      expect(res.body.every((r: { status?: string }) => r.status === undefined)).toBe(true);

      const nonAdmin = await signedIn(await user());
      expect((await nonAdmin.get('/api/admin/registrations')).status).toBe(403);
      expect((await supertest(app.getHttpServer()).get('/api/admin/registrations')).status).toBe(401);
    });

    it('valide une inscription : compte actif et « Cave de … » dont il est OWNER', async () => {
      const admin = await signedIn(await user({ isAdmin: true }));
      const pending = await user({ status: 'PENDING', displayName: `Valentin ${run}` });

      const res = await admin.post(`/api/admin/registrations/${pending.id}/validate`);
      expect(res.status).toBe(201);
      expect((await prisma.appUser.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('ACTIVE');
      const owned = await prisma.cave.findMany({ where: { ownerId: pending.id }, include: { members: true } });
      expect(owned).toHaveLength(1);
      expect(owned[0].name).toBe(`Cave de Valentin ${run}`);
      expect(owned[0].members).toEqual([expect.objectContaining({ userId: pending.id, role: 'OWNER' })]);

      const again = await admin.post(`/api/admin/registrations/${pending.id}/validate`);
      expect(again.status).toBe(404);
      expect((await admin.post(`/api/admin/registrations/${randomUUID()}/validate`)).status).toBe(404);

      // Le compte validé sort de l'attente.
      const me = await (await signedIn(pending)).get('/api/auth/me');
      expect(me.body).toMatchObject({ status: 'ACTIVE', currentCaveId: owned[0].id });
    });

    it('refuse une inscription : compte bloqué, sans cave', async () => {
      const admin = await signedIn(await user({ isAdmin: true }));
      const pending = await user({ status: 'PENDING' });
      const res = await admin.post(`/api/admin/registrations/${pending.id}/refuse`);
      expect(res.status).toBe(201);
      expect((await prisma.appUser.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('BLOCKED');
      expect(await prisma.cave.count({ where: { ownerId: pending.id } })).toBe(0);
      expect((await admin.post(`/api/admin/registrations/${pending.id}/refuse`)).status).toBe(404);
      const active = await user();
      expect((await admin.post(`/api/admin/registrations/${active.id}/refuse`)).status).toBe(404);
    });

    it('crée la cave d’un compte actif qui n’en a pas, 409 s’il en a une, 404 s’il est inconnu', async () => {
      const admin = await signedIn(await user({ isAdmin: true }));
      const guest = await user({ email: `invite-${run}@example.test` });

      const listed = await admin.get('/api/admin/users');
      expect(listed.body.find((u: { id: string }) => u.id === guest.id)).toMatchObject({ hasCave: false });

      const res = await admin.post(`/api/admin/users/${guest.id}/cave`);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: expect.any(String), name: `Cave de invite-${run}@example.test` });
      expect(await prisma.caveMember.findFirst({ where: { caveId: res.body.id, userId: guest.id } })).toMatchObject({ role: 'OWNER' });
      expect((await admin.get('/api/admin/users')).body.find((u: { id: string }) => u.id === guest.id)).toMatchObject({ hasCave: true });

      const conflict = await admin.post(`/api/admin/users/${guest.id}/cave`);
      expect(conflict.status).toBe(409);
      expect(conflict.body.message).toBe('Ce compte a déjà une cave');
      expect((await admin.post(`/api/admin/users/${randomUUID()}/cave`)).status).toBe(404);
      const pending = await user({ status: 'PENDING' });
      expect((await admin.post(`/api/admin/users/${pending.id}/cave`)).status).toBe(400);
    });
  });
});
