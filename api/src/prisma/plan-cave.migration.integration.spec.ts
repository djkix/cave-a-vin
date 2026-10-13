import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migration « plan de la cave » éprouvée sur une base au format précédent : un
 * schéma PostgreSQL dédié dans la base de test, toutes les migrations
 * précédentes, une cave et ses zones comme en production, puis le SQL livré, en
 * un seul envoi. Le schéma `public` n'est jamais touché ; le schéma d'essai est
 * supprimé à la fin.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const MIGRATION = '20261017000000_plan_cave';
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const PRISMA_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');

const migrationSql = (name: string) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

const previousMigrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name < MIGRATION)
  .map((d) => d.name)
  .sort();

describeIfDb('migration plan de la cave (base au format précédent)', () => {
  const prisma = new PrismaClient();
  const schema = `plan_mig_${process.pid}`;
  const q = <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);

  function execute(sql: string): void {
    execFileSync(PRISMA_BIN, ['db', 'execute', '--stdin', '--url', process.env.DATABASE_URL!], {
      input: `SET search_path TO "${schema}", public;\n${sql}`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Repère de la zone z1 ; rejeté : le nom de la contrainte violée, sinon null. */
  async function setMarker(x: string, y: string): Promise<string | null> {
    try {
      await prisma.$executeRawUnsafe(`UPDATE "${schema}".cave_zone SET plan_x = ${x}, plan_y = ${y} WHERE id = 'z1'`);
      return null;
    } catch (e) {
      return (String((e as Error).message).match(/cave_zone_\w+_check/) ?? ['refusé sans contrainte nommée'])[0];
    }
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const name of previousMigrations) execute(migrationSql(name));
    execute(`
      INSERT INTO cave (id, name) VALUES ('cave-a', 'Cave A');
      INSERT INTO cave_zone (id, cave_id, name, indication, photo_path, sort_order) VALUES
        ('z1', 'cave-a', 'Cave 1', 'À gauche', 'zones/z1.jpg', 0),
        ('z2', 'cave-a', 'Garage', NULL, NULL, 1);
    `);
    execute(migrationSql(MIGRATION));
  }, 120_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  it('part bien du format précédent (lots d’accords)', () => {
    expect(previousMigrations[previousMigrations.length - 1]).toBe('20261016000000_lots_accords');
  });

  it('ajoute à cave le plan (chemin, taille en pixels, date), nul par défaut', async () => {
    const columns = await q<{ column_name: string; data_type: string; is_nullable: string }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = 'cave' AND column_name LIKE 'plan_%' ORDER BY column_name`);
    expect(columns).toEqual([
      { column_name: 'plan_height', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'plan_path', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'plan_updated_at', data_type: 'timestamp without time zone', is_nullable: 'YES' },
      { column_name: 'plan_width', data_type: 'integer', is_nullable: 'YES' },
    ]);
    expect(await q(`SELECT id, name, plan_path, plan_width, plan_height, plan_updated_at FROM "${schema}".cave`)).toEqual([
      { id: 'cave-a', name: 'Cave A', plan_path: null, plan_width: null, plan_height: null, plan_updated_at: null },
    ]);
  });

  it('ajoute aux zones un repère facultatif (fractions en double précision), sans toucher aux zones existantes', async () => {
    const columns = await q<{ column_name: string; data_type: string; is_nullable: string }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = 'cave_zone' AND column_name LIKE 'plan_%' ORDER BY column_name`);
    expect(columns).toEqual([
      { column_name: 'plan_x', data_type: 'double precision', is_nullable: 'YES' },
      { column_name: 'plan_y', data_type: 'double precision', is_nullable: 'YES' },
    ]);
    expect(await q(`SELECT id, name, indication, photo_path, sort_order, plan_x, plan_y FROM "${schema}".cave_zone ORDER BY id`)).toEqual([
      { id: 'z1', name: 'Cave 1', indication: 'À gauche', photo_path: 'zones/z1.jpg', sort_order: 0, plan_x: null, plan_y: null },
      { id: 'z2', name: 'Garage', indication: null, photo_path: null, sort_order: 1, plan_x: null, plan_y: null },
    ]);
  });

  it('CHECK : les deux nuls, ou les deux entre 0 et 1 (bornes comprises)', async () => {
    for (const [x, y] of [['0', '0'], ['1', '1'], ['0.25', '0.75'], ['NULL', 'NULL']]) expect(await setMarker(x, y)).toBeNull();
    for (const [x, y] of [['0.5', 'NULL'], ['NULL', '0.5'], ['1.01', '0.5'], ['0.5', '-0.01'], [`'NaN'`, '0.5'], [`'Infinity'`, '0.5']]) {
      expect(await setMarker(x, y)).toBe('cave_zone_plan_position_check');
    }
  });
});
