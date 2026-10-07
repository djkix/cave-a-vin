import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppUser } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

// Membres de la cave courante (propriétaire seulement), renommage de la cave
// et part de budget par cave (administrateur), en HTTP contre le vrai
// AppModule. Comme les autres suites HTTP, une route de test montée par ce seul
// fichier ouvre la session d'un compte créé en base.
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfInfra('membres de la cave et part de budget (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('../prisma/prisma.service').PrismaService;
  let auth: import('../auth/auth.service').AuthService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const caveIds: string[] = [];
  let caveA: string;
  let caveB: string;
  let uOwnerA: AppUser;
  let uViewerA: AppUser;
  let uOwnerB: AppUser;
  let ownerA: supertest.Agent;
  let viewerA: supertest.Agent;
  let ownerB: supertest.Agent;
  let admin: supertest.Agent;
  let savedShare: string | null = null;

  const email = (name: string) => `members-${run}-${name}@example.test`;

  beforeAll(async () => {
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    delete process.env.BREAK_GLASS_EMAIL;
    delete process.env.BREAK_GLASS_PASSWORD;

    const { AppModule } = await import('../app.module');
    const { setupSession } = await import('../auth/session.setup');
    const { PrismaService } = await import('../prisma/prisma.service');
    const { AuthService } = await import('../auth/auth.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    sessionRedis = setupSession(app);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    app.use('/__test/login', (req: any, res: any) => {
      prisma.appUser
        .findUniqueOrThrow({ where: { id: String(req.query.id) } })
        .then((user) => req.logIn(user, (err: unknown) => (err ? res.status(500).end() : res.status(204).end())))
        .catch(() => res.status(500).end());
    });
    await app.listen(0, '127.0.0.1');

    savedShare = (await prisma.appSetting.findUnique({ where: { key: 'cave_budget_share' } }))?.value ?? null;

    const user = async (name: string, data: Partial<AppUser> = {}) => {
      const u = await prisma.appUser.create({ data: { email: email(name), displayName: `Nom ${name}`, ...data } });
      userIds.push(u.id);
      return u;
    };
    uOwnerA = await user('owner-a');
    uViewerA = await user('viewer-a');
    uOwnerB = await user('owner-b');
    const uAdmin = await user('admin', { isAdmin: true });
    caveA = (await createTestCave(prisma, { owner: uOwnerA, name: `Membres A ${run}` })).id;
    caveB = (await createTestCave(prisma, { owner: uOwnerB, name: `Membres B ${run}` })).id;
    caveIds.push(caveA, caveB);
    await prisma.caveMember.create({ data: { caveId: caveA, userId: uViewerA.id, role: 'VIEWER' } });

    const signedIn = async (u: AppUser) => {
      const agent = supertest.agent(app.getHttpServer());
      expect((await agent.get(`/__test/login?id=${u.id}`)).status).toBe(204);
      return agent;
    };
    [ownerA, viewerA, ownerB, admin] = [await signedIn(uOwnerA), await signedIn(uViewerA), await signedIn(uOwnerB), await signedIn(uAdmin)];
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      // Réglage partagé de la base de test : remis tel qu'il était.
      if (savedShare === null) await prisma.appSetting.deleteMany({ where: { key: 'cave_budget_share' } });
      else await prisma.appSetting.upsert({ where: { key: 'cave_budget_share' }, create: { key: 'cave_budget_share', value: savedShare }, update: { value: savedShare } });
      await deleteTestCaves(prisma, caveIds);
      const extra = await prisma.appUser.findMany({ where: { email: { startsWith: `members-${run}-` } }, select: { id: true } });
      await prisma.appUser.deleteMany({ where: { id: { in: [...userIds, ...extra.map((u) => u.id)] } } });
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
  });

  describe('GET /api/caves/current/members', () => {
    it('propriétaire : le propriétaire d’abord, puis les membres et invitations par date', async () => {
      await prisma.caveMember.create({ data: { caveId: caveA, invitedEmail: email('listed'), role: 'VIEWER' } });
      const res = await ownerA.get('/api/caves/current/members');
      expect(res.status).toBe(200);
      expect(res.body[0]).toEqual({ id: expect.any(String), email: uOwnerA.email, displayName: uOwnerA.displayName, role: 'OWNER', pending: false });
      expect(res.body[1]).toEqual({ id: expect.any(String), email: uViewerA.email, displayName: uViewerA.displayName, role: 'VIEWER', pending: false });
      expect(res.body).toContainEqual({ id: expect.any(String), email: email('listed'), displayName: null, role: 'VIEWER', pending: true });
      // Rien d'une autre cave.
      expect(res.body.map((m: { email: string }) => m.email)).not.toContain(uOwnerB.email);
    });

    it('membre (VIEWER) : 403 « Lecture seule »', async () => {
      const res = await viewerA.get('/api/caves/current/members');
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Lecture seule');
    });

    it('sans session : 401', async () => {
      expect((await supertest(app.getHttpServer()).get('/api/caves/current/members')).status).toBe(401);
    });
  });

  describe('POST /api/caves/current/members', () => {
    it('adresse sans compte : invitation en attente, adresse normalisée', async () => {
      const res = await ownerA.post('/api/caves/current/members').send({ email: `  ${email('Invite-One').toUpperCase()}  ` });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: expect.any(String), email: email('invite-one'), displayName: null, role: 'VIEWER', pending: true });
      const row = await prisma.caveMember.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ caveId: caveA, userId: null, invitedEmail: email('invite-one'), role: 'VIEWER' });
    });

    it('409 « Cette adresse est déjà membre » pour une invitation en double, même en majuscules ou avec des espaces', async () => {
      await ownerA.post('/api/caves/current/members').send({ email: email('dup') });
      for (const variant of [email('dup'), email('DUP').toUpperCase(), `  ${email('dup')} `]) {
        const res = await ownerA.post('/api/caves/current/members').send({ email: variant });
        expect(res.status).toBe(409);
        expect(res.body.message).toBe('Cette adresse est déjà membre');
      }
    });

    it('409 pour un membre déjà rattaché et pour l’adresse du propriétaire', async () => {
      for (const address of [uViewerA.email, uOwnerA.email.toUpperCase()]) {
        const res = await ownerA.post('/api/caves/current/members').send({ email: address });
        expect(res.status).toBe(409);
        expect(res.body.message).toBe('Cette adresse est déjà membre');
      }
    });

    it('compte existant : rattaché directement comme VIEWER', async () => {
      const res = await ownerA.post('/api/caves/current/members').send({ email: uOwnerB.email });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: expect.any(String), email: uOwnerB.email, displayName: uOwnerB.displayName, role: 'VIEWER', pending: false });
      const row = await prisma.caveMember.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ caveId: caveA, userId: uOwnerB.id, invitedEmail: null });
      // Le propriétaire de B voit maintenant aussi la cave A, en lecture.
      const me = await ownerB.get('/api/auth/me');
      expect(me.body.caves).toContainEqual({ id: caveA, name: expect.any(String), role: 'VIEWER' });
      await prisma.caveMember.delete({ where: { id: res.body.id } });
    });

    it('compte en attente rattaché : il devient actif (l’invitation suffit)', async () => {
      const pending = await prisma.appUser.create({ data: { email: email('pending'), displayName: 'En attente', status: 'PENDING' } });
      userIds.push(pending.id);
      const res = await ownerA.post('/api/caves/current/members').send({ email: email('pending') });
      expect(res.status).toBe(201);
      expect(res.body.pending).toBe(false);
      expect((await prisma.appUser.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('ACTIVE');
    });

    it('compte bloqué rattaché : il reste bloqué', async () => {
      const blocked = await prisma.appUser.create({ data: { email: email('blocked'), status: 'BLOCKED' } });
      userIds.push(blocked.id);
      const res = await ownerA.post('/api/caves/current/members').send({ email: email('blocked') });
      expect(res.status).toBe(201);
      expect((await prisma.appUser.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe('BLOCKED');
    });

    it('400 avec un message en français pour une adresse invalide', async () => {
      for (const body of [{ email: 'pas-une-adresse' }, { email: '' }, {}, { email: 42 }]) {
        const res = await ownerA.post('/api/caves/current/members').send(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Adresse e-mail invalide');
      }
    });

    it('membre (VIEWER) : 403', async () => {
      expect((await viewerA.post('/api/caves/current/members').send({ email: email('by-viewer') })).status).toBe(403);
    });

    it('invitation puis première connexion Google : le compte est actif et rattaché', async () => {
      const invited = await ownerA.post('/api/caves/current/members').send({ email: email('google') });
      expect(invited.status).toBe(201);
      const user = await auth.findOrCreateGoogleUser({ sub: `members-${run}-sub`, email: email('Google').toUpperCase(), displayName: 'Invité Google' });
      userIds.push(user.id);
      expect(user.status).toBe('ACTIVE');
      const row = await prisma.caveMember.findUniqueOrThrow({ where: { id: invited.body.id } });
      expect(row).toMatchObject({ userId: user.id, invitedEmail: null, role: 'VIEWER' });
      const list = await ownerA.get('/api/caves/current/members');
      expect(list.body).toContainEqual({ id: invited.body.id, email: email('google'), displayName: 'Invité Google', role: 'VIEWER', pending: false });
    });
  });

  describe('DELETE /api/caves/current/members/:id', () => {
    it('retire un membre ou une invitation (204) ; le membre retiré perd l’accès', async () => {
      const removed = await prisma.appUser.create({ data: { email: email('removed') } });
      userIds.push(removed.id);
      const member = await prisma.caveMember.create({ data: { caveId: caveA, userId: removed.id, role: 'VIEWER' } });
      const invitation = await prisma.caveMember.create({ data: { caveId: caveA, invitedEmail: email('removed-invite'), role: 'VIEWER' } });
      const agent = supertest.agent(app.getHttpServer());
      await agent.get(`/__test/login?id=${removed.id}`);
      expect((await agent.get('/api/cave')).status).toBe(200);

      expect((await ownerA.delete(`/api/caves/current/members/${member.id}`)).status).toBe(204);
      expect((await ownerA.delete(`/api/caves/current/members/${invitation.id}`)).status).toBe(204);
      expect(await prisma.caveMember.count({ where: { id: { in: [member.id, invitation.id] } } })).toBe(0);
      // Sa session n'a plus de cave : la cave courante est revérifiée à chaque requête.
      const after = await agent.get('/api/cave');
      expect(after.status).toBe(404);
      expect(after.body.message).toBe('Cave introuvable');
    });

    it('400 « Le propriétaire ne peut pas être retiré »', async () => {
      const owner = await prisma.caveMember.findFirstOrThrow({ where: { caveId: caveA, role: 'OWNER' } });
      const res = await ownerA.delete(`/api/caves/current/members/${owner.id}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Le propriétaire ne peut pas être retiré');
      expect(await prisma.caveMember.count({ where: { id: owner.id } })).toBe(1);
    });

    it('404 pour un membre d’une autre cave, sans le retirer', async () => {
      const foreign = await prisma.caveMember.create({ data: { caveId: caveB, invitedEmail: email('foreign'), role: 'VIEWER' } });
      const res = await ownerA.delete(`/api/caves/current/members/${foreign.id}`);
      expect(res.status).toBe(404);
      expect(await prisma.caveMember.count({ where: { id: foreign.id } })).toBe(1);
      const ownerBRow = await prisma.caveMember.findFirstOrThrow({ where: { caveId: caveB, role: 'OWNER' } });
      expect((await ownerA.delete(`/api/caves/current/members/${ownerBRow.id}`)).status).toBe(404);
    });

    it('400 pour un identifiant qui n’est pas un UUID ; 404 pour un inconnu', async () => {
      expect((await ownerA.delete('/api/caves/current/members/abc')).status).toBe(400);
      expect((await ownerA.delete(`/api/caves/current/members/${randomUUID()}`)).status).toBe(404);
    });

    it('membre (VIEWER) : 403', async () => {
      const own = await prisma.caveMember.findFirstOrThrow({ where: { caveId: caveA, userId: uViewerA.id } });
      expect((await viewerA.delete(`/api/caves/current/members/${own.id}`)).status).toBe(403);
    });
  });

  describe('PATCH /api/caves/current', () => {
    it('renomme la cave courante (nom nettoyé) et rend { id, name }', async () => {
      const res = await ownerA.patch('/api/caves/current').send({ name: `  Cave renommée ${run}  ` });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: caveA, name: `Cave renommée ${run}` });
      expect((await prisma.cave.findUniqueOrThrow({ where: { id: caveA } })).name).toBe(`Cave renommée ${run}`);
      expect((await prisma.cave.findUniqueOrThrow({ where: { id: caveB } })).name).toBe(`Membres B ${run}`);
    });

    it('accepte 80 caractères, refuse vide, blanc, 81 caractères ou un non-texte (400 en français)', async () => {
      expect((await ownerA.patch('/api/caves/current').send({ name: 'x'.repeat(80) })).status).toBe(200);
      for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 12 }, {}]) {
        const res = await ownerA.patch('/api/caves/current').send(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Le nom de la cave doit faire de 1 à 80 caractères');
      }
    });

    it('membre (VIEWER) : 403', async () => {
      expect((await viewerA.patch('/api/caves/current').send({ name: 'Pirate' })).status).toBe(403);
    });
  });

  describe('/api/admin/budget', () => {
    it('GET : part par cave, plafond et dépense du mois', async () => {
      await prisma.appSetting.upsert({ where: { key: 'cave_budget_share' }, create: { key: 'cave_budget_share', value: '0.2' }, update: { value: '0.2' } });
      const res = await admin.get('/api/admin/budget');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ caveShare: 0.2, invitedShare: expect.any(Number), capCents: expect.any(Number), spentThisMonthCents: expect.any(Number) });
    });

    it('GET : réglage absent → 0,2', async () => {
      await prisma.appSetting.deleteMany({ where: { key: 'cave_budget_share' } });
      try {
        expect((await admin.get('/api/admin/budget')).body.caveShare).toBe(0.2);
      } finally {
        await prisma.appSetting.create({ data: { key: 'cave_budget_share', value: '0.2' } });
      }
    });

    // 0 est accepté aussi (test du schéma) : jamais posé ici, la base de test est partagée.
    it('PUT : enregistre une part de 0 à 1 inclus', async () => {
      for (const caveShare of [0.35, 1]) {
        const res = await admin.put('/api/admin/budget').send({ caveShare });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ caveShare, invitedShare: expect.any(Number), capCents: expect.any(Number), spentThisMonthCents: expect.any(Number) });
        expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'cave_budget_share' } })).value).toBe(String(caveShare));
      }
      await admin.put('/api/admin/budget').send({ caveShare: 0.2 });
    });

    it('PUT : 400 hors de 0 à 1 ou si ce n’est pas un nombre', async () => {
      for (const body of [{ caveShare: 1.01 }, { caveShare: -0.1 }, { caveShare: '0.3' }, { caveShare: null }, {}]) {
        const res = await admin.put('/api/admin/budget').send(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('La part par cave doit être comprise entre 0 et 1');
      }
    });

    it('PUT : enregistre la part de l’ensemble des caves invitées, sans toucher à la part par cave', async () => {
      const before = (await admin.get('/api/admin/budget')).body.invitedShare;
      try {
        const res = await admin.put('/api/admin/budget').send({ invitedShare: 0.45 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ invitedShare: 0.45, caveShare: 0.2 });
        for (const invitedShare of [1.5, '0.4', null]) {
          const bad = await admin.put('/api/admin/budget').send({ invitedShare });
          expect(bad.status).toBe(400);
          expect(bad.body.message).toBe('La part des caves invitées doit être comprise entre 0 et 1');
        }
      } finally {
        await admin.put('/api/admin/budget').send({ invitedShare: before });
      }
    });

    it('non-administrateur : 403', async () => {
      expect((await ownerA.get('/api/admin/budget')).status).toBe(403);
      expect((await ownerA.put('/api/admin/budget').send({ caveShare: 0.5 })).status).toBe(403);
    });
  });
});
