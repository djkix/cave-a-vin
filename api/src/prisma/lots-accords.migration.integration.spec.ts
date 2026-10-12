import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migration « lots d'accords et de descriptifs » éprouvée sur une base au
 * format précédent : un schéma PostgreSQL dédié dans la base de test, toutes
 * les migrations précédentes, quelques accords et descriptifs comme en
 * production, puis le SQL livré, en un seul envoi. Le schéma `public` n'est
 * jamais touché ; le schéma d'essai est supprimé à la fin.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const MIGRATION = '20261016000000_lots_accords';
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const PRISMA_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');

const migrationSql = (name: string) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

const previousMigrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name < MIGRATION)
  .map((d) => d.name)
  .sort();

describeIfDb('migration lots d’accords et de descriptifs (base au format précédent)', () => {
  const prisma = new PrismaClient();
  const schema = `lots_mig_${process.pid}`;
  const q = <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);
  let dbNow: Date;
  const DAY = 24 * 60 * 60_000;

  function execute(sql: string): void {
    execFileSync(PRISMA_BIN, ['db', 'execute', '--stdin', '--url', process.env.DATABASE_URL!], {
      input: `SET search_path TO "${schema}", public;\n${sql}`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const name of previousMigrations) execute(migrationSql(name));
    // Dates relatives à l'horloge de la base : la migration borne la date de demande à un jour en arrière.
    execute(`
      INSERT INTO cave (id, name) VALUES ('cave-a', 'Cave A');
      INSERT INTO wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES
        ('w1', 'cave-a', 'k1', 'Domaine Tempier', 'Bandol', 'ROUGE'),
        ('w2', 'cave-a', 'k2', 'Trimbach', 'Alsace', 'BLANC'),
        ('w3', 'cave-a', 'k3', 'Mas Jullien', 'Languedoc', 'ROUGE'),
        ('w4', 'cave-a', 'k4', 'Clos Rougeard', 'Saumur', 'ROUGE');
      INSERT INTO pairing (id, wine_id, status, updated_at, error_message, generated_at) VALUES
        ('p1', 'w1', 'PENDING', '2026-10-01 08:00:00', NULL, NULL),
        ('p2', 'w2', 'DONE', '2026-10-02 09:00:00', NULL, '2026-10-02 09:00:00'),
        ('p3', 'w3', 'PENDING', (now() AT TIME ZONE 'UTC') - interval '1 hour', NULL, NULL),
        ('p4', 'w4', 'FAILED', '2026-10-03 09:00:00', 'Réponse de Gemini inexploitable', NULL);
      INSERT INTO producer_profile (id, producer_key, display_name, status, source, description, error_message, updated_at) VALUES
        ('pp1', 'domaine tempier', 'Domaine Tempier', 'PENDING', 'GEMINI', NULL, NULL, '2026-10-03 10:00:00'),
        ('pp2', 'trimbach', 'Trimbach', 'UNKNOWN', 'GEMINI', NULL, NULL, '2026-10-04 11:00:00'),
        ('pp3', 'mas jullien', 'Mas Jullien', 'FAILED', 'GEMINI', NULL, 'Génération impossible : configuration Gemini à vérifier', '2026-10-04 11:00:00'),
        ('pp4', 'clos rougeard', 'Clos Rougeard', 'FAILED', 'MANUEL', 'Texte saisi', 'ancien échec', '2026-10-04 11:00:00');
    `);
    dbNow = (await q<{ now: Date }>(`SELECT (now() AT TIME ZONE 'UTC') AS now`))[0].now;
    execute(migrationSql(MIGRATION));
  }, 120_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  it('part bien du format précédent (zones)', () => {
    expect(previousMigrations[previousMigrations.length - 1]).toBe('20261015000000_zones');
  });

  it.each(['pairing', 'producer_profile'])('ajoute à %s les colonnes de la file', async (table) => {
    const columns = await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = '${table}'
        AND column_name IN ('requested_at', 'attempts', 'next_attempt_at', 'reserved_until')
      ORDER BY column_name`);
    expect(columns.map((c) => ({ column_name: c.column_name, data_type: c.data_type, is_nullable: c.is_nullable }))).toEqual([
      { column_name: 'attempts', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'next_attempt_at', data_type: 'timestamp without time zone', is_nullable: 'YES' },
      { column_name: 'requested_at', data_type: 'timestamp without time zone', is_nullable: 'NO' },
      { column_name: 'reserved_until', data_type: 'timestamp without time zone', is_nullable: 'YES' },
    ]);
    expect(columns[0].column_default).toBe('0');
    // Date par défaut en UTC, comme celles que Prisma écrit.
    expect(columns[2].column_default).toMatch(/AT TIME ZONE 'UTC'/);
  });

  it('date les demandes déjà en attente de leur dernière mise à jour, jamais plus d’un jour en arrière', async () => {
    const pairings = await q<{ id: string; status: string; requested_at: Date; updated_at: Date; attempts: number; next_attempt_at: Date | null; reserved_until: Date | null }>(
      `SELECT id, status::text AS status, requested_at, updated_at, attempts, next_attempt_at, reserved_until FROM "${schema}".pairing ORDER BY id`,
    );
    const byId = new Map(pairings.map((p) => [p.id, p]));
    // p1 : mise à jour il y a plus d'un jour → un jour en arrière (à la seconde près, l'horloge avance pendant le test).
    expect(Math.abs(byId.get('p1')!.requested_at.getTime() - (dbNow.getTime() - DAY))).toBeLessThan(60_000);
    expect(byId.get('p1')).toMatchObject({ status: 'PENDING', attempts: 0, next_attempt_at: null, reserved_until: null });
    // p3 : mise à jour il y a une heure → sa propre date.
    expect(byId.get('p3')!.requested_at).toEqual(byId.get('p3')!.updated_at);
    expect(byId.get('p2')).toMatchObject({ status: 'DONE', attempts: 0, next_attempt_at: null, reserved_until: null });
    const profiles = await q<{ id: string; status: string; requested_at: Date }>(
      `SELECT id, status::text AS status, requested_at FROM "${schema}".producer_profile ORDER BY id`,
    );
    expect(profiles[0].status).toBe('PENDING');
    expect(Math.abs(profiles[0].requested_at.getTime() - (dbNow.getTime() - DAY))).toBeLessThan(60_000);
    expect(profiles[1]).toMatchObject({ id: 'pp2', status: 'UNKNOWN' });
  });

  it('relance une fois les accords et descriptifs Gemini en échec, jamais un texte saisi à la main', async () => {
    const [p4] = await q<{ status: string; attempts: number; next_attempt_at: Date | null; error_message: string | null; requested_at: Date }>(
      `SELECT status::text AS status, attempts, next_attempt_at, error_message, requested_at FROM "${schema}".pairing WHERE id = 'p4'`,
    );
    expect(p4).toMatchObject({ status: 'PENDING', attempts: 0, next_attempt_at: null, error_message: null });
    expect(Math.abs(p4.requested_at.getTime() - dbNow.getTime())).toBeLessThan(60_000);
    const profiles = await q<{ id: string; status: string; error_message: string | null; description: string | null; source: string }>(
      `SELECT id, status::text AS status, error_message, description, source FROM "${schema}".producer_profile WHERE id IN ('pp3', 'pp4') ORDER BY id`,
    );
    expect(profiles).toEqual([
      { id: 'pp3', status: 'PENDING', error_message: null, description: null, source: 'GEMINI' },
      { id: 'pp4', status: 'FAILED', error_message: 'ancien échec', description: 'Texte saisi', source: 'MANUEL' },
    ]);
  });

  it('indexe la requête de choix du lot (statut, date de demande)', async () => {
    const indexes = await q<{ tablename: string; indexname: string; indexdef: string }>(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = '${schema}' AND tablename IN ('pairing', 'producer_profile') AND indexname LIKE '%requested_at%'
      ORDER BY tablename`);
    expect(indexes.map((i) => [i.tablename, i.indexname])).toEqual([
      ['pairing', 'pairing_status_requested_at_idx'],
      ['producer_profile', 'producer_profile_status_requested_at_idx'],
    ]);
    indexes.forEach((i) => expect(i.indexdef).toContain('(status, requested_at)'));
  });
});
