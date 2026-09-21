import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

  beforeAll(async () => {
    // Doit précéder le premier loadEnv(), donc le premier import de app.module.
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.BREAK_GLASS_EMAIL ??= 'e2e@example.com';
    process.env.BREAK_GLASS_PASSWORD ??= 'e2e-break-glass-password';
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    email = process.env.BREAK_GLASS_EMAIL;
    password = process.env.BREAK_GLASS_PASSWORD;

    const { AppModule } = await import('./app.module');
    const { setupSession } = await import('./auth/session.setup');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    sessionRedis = setupSession(app);
    await app.init();
    agent = supertest.agent(app.getHttpServer());
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

  it('downloads the Excel workbook as an attachment', async () => {
    const res = await agent.get('/api/export.xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="cave-\d{4}-\d{2}-\d{2}\.xlsx"/);
  });

  it('rate-limits brute force on the break-glass login', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await supertest(app.getHttpServer()).post('/api/auth/local-login').send({ email, password: 'mauvais-mot-de-passe' });
      last = res.status;
    }
    expect(last).toBe(429);
  }, 30_000);
});
