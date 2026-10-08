import { PrismaClient } from '@prisma/client';
import { GeminiUsageService } from '../admin/gemini-usage.service';
import { GEMINI_PAUSE_REASON_KEY, GEMINI_PAUSE_UNTIL_KEY, GeminiJournal } from '../vision/gemini-journal';

/**
 * Migration 20261014000000_gemini_call et agrégation de la consommation sur
 * une vraie base (cave_test, migrations appliquées par `prisma migrate deploy`).
 *
 * La pause commune est éprouvée avec des dates passées : une pause active
 * suspendrait les autres suites qui tournent en parallèle sur la même base.
 * Les réglages de pause d'origine sont remis en place à la fin.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('journal des appels Gemini (base réelle)', () => {
  const prisma = new PrismaClient();
  const quiet = { warn: () => undefined, error: () => undefined };
  const created: string[] = [];
  let saved: Array<{ key: string; value: string }> = [];

  beforeAll(async () => {
    saved = await prisma.appSetting.findMany({ where: { key: { in: [GEMINI_PAUSE_UNTIL_KEY, GEMINI_PAUSE_REASON_KEY] } } });
  });

  afterAll(async () => {
    await prisma.geminiCall.deleteMany({ where: { id: { in: created } } });
    await prisma.appSetting.deleteMany({ where: { key: { in: [GEMINI_PAUSE_UNTIL_KEY, GEMINI_PAUSE_REASON_KEY] } } });
    if (saved.length) await prisma.appSetting.createMany({ data: saved });
    await prisma.$disconnect();
  });

  it('crée la table avec ses colonnes, son index sur created_at et une date par défaut en UTC', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string }>>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'gemini_call' ORDER BY column_name`;
    expect(columns).toEqual([
      { column_name: 'cost_cents', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp without time zone', is_nullable: 'NO' },
      { column_name: 'duration_ms', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'http_status', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'outcome', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'reason', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'usage', data_type: 'text', is_nullable: 'NO' },
    ]);
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'gemini_call' ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual(['gemini_call_created_at_idx', 'gemini_call_pkey']);

    // Écriture SQL sans date ni coût, dans une session réglée sur un autre fuseau : la date reste en UTC.
    const id = `essai-${Date.now()}`;
    created.push(id);
    const before = Date.now();
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`),
      prisma.$executeRaw`INSERT INTO gemini_call (id, usage, outcome, duration_ms) VALUES (${id}, 'ACCORDS', 'OK', 5)`,
    ]);
    const row = await prisma.geminiCall.findUniqueOrThrow({ where: { id } });
    expect(row.costCents).toBe(0);
    expect(Math.abs(row.createdAt.getTime() - before)).toBeLessThan(60_000);
  });

  it('refuse un usage ou une issue inconnus', async () => {
    await expect(prisma.geminiCall.create({ data: { usage: 'AUTRE', outcome: 'OK', durationMs: 1 } })).rejects.toThrow();
    await expect(prisma.geminiCall.create({ data: { usage: 'ACCORDS', outcome: 'PEUT-ETRE', durationMs: 1 } })).rejects.toThrow();
  });

  it('agrège par jour de Paris et par usage', async () => {
    // Période d'essai en 2001 : aucune autre ligne de la base n'y tombe.
    const now = new Date('2001-06-15T10:00:00.000Z');
    const rows = [
      { createdAt: new Date('2001-06-14T22:30:00.000Z'), usage: 'LECTURE_SORTIE', outcome: 'REFUSE', httpStatus: 503 }, // 15 juin à Paris
      { createdAt: new Date('2001-06-15T08:00:00.000Z'), usage: 'LECTURE_SORTIE', outcome: 'OK', httpStatus: null, costCents: 2 },
      { createdAt: new Date('2001-06-14T21:30:00.000Z'), usage: 'LECTURE_SORTIE', outcome: 'REFUSE', httpStatus: 429 }, // 14 juin à Paris
      { createdAt: new Date('2001-06-14T12:00:00.000Z'), usage: 'DESCRIPTIF', outcome: 'ERREUR', httpStatus: 500 },
    ];
    for (const r of rows) {
      const c = await prisma.geminiCall.create({ data: { ...r, durationMs: 10 } });
      created.push(c.id);
    }
    const report = await new GeminiUsageService(prisma as never, new GeminiJournal(prisma, quiet)).report(2, now);
    expect(report.rows).toEqual([
      { day: '2001-06-15', usage: 'LECTURE_SORTIE', ok: 1, refused503: 1, refused429: 0, errors: 0, costCents: 2 },
      { day: '2001-06-14', usage: 'LECTURE_SORTIE', ok: 0, refused503: 0, refused429: 1, errors: 0, costCents: 0 },
      { day: '2001-06-14', usage: 'DESCRIPTIF', ok: 0, refused503: 0, refused429: 0, errors: 1, costCents: 0 },
    ]);
    expect(report.totals).toEqual({ ok: 1, refused: 2, errors: 1, costCents: 2 });
    expect(report.pause).toEqual({ until: null, reason: null });
  });

  it('la pause ne raccourcit jamais une échéance plus lointaine, même sur deux refus simultanés', async () => {
    const journal = new GeminiJournal(prisma, quiet);
    const t0 = new Date('2001-01-01T00:00:00.000Z');
    await prisma.appSetting.deleteMany({ where: { key: { in: [GEMINI_PAUSE_UNTIL_KEY, GEMINI_PAUSE_REASON_KEY] } } });
    await Promise.all([journal.extendPause(429, t0), journal.extendPause(503, t0), journal.extendPause(503, t0)]);
    const value = async (key: string) => (await prisma.appSetting.findUnique({ where: { key } }))?.value;
    expect(await value(GEMINI_PAUSE_UNTIL_KEY)).toBe('2001-01-01T01:00:00.000Z');
    expect(await value(GEMINI_PAUSE_REASON_KEY)).toBe('quota épuisé');
    await journal.extendPause(503, new Date('2001-01-01T00:30:00.000Z'));
    expect(await value(GEMINI_PAUSE_UNTIL_KEY)).toBe('2001-01-01T01:00:00.000Z');
    await journal.extendPause(503, new Date('2001-01-01T00:58:00.000Z'));
    expect(await value(GEMINI_PAUSE_UNTIL_KEY)).toBe('2001-01-01T01:03:00.000Z');
    expect(await value(GEMINI_PAUSE_REASON_KEY)).toBe('modèle saturé');
    // Échue : aucune pause en cours aujourd'hui.
    await expect(journal.currentPause()).resolves.toBeNull();
  });
});
