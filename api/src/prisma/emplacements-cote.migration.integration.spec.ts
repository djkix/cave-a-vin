import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migration « emplacements et cote » éprouvée sur une base au format précédent.
 *
 * Même approche que multi-caves.migration.integration.spec.ts : un schéma
 * PostgreSQL dédié dans la base de test, toutes les migrations précédentes,
 * des données comme en production, puis le SQL de la nouvelle migration tel
 * qu'il est livré, en un seul envoi (donc dans une transaction, ce qui vérifie
 * que la valeur d'enum MOVE n'y est pas employée). Le schéma est supprimé à la
 * fin ; le schéma `public` de la base de test n'est jamais touché.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const MIGRATION = '20261013000000_emplacements_cote';
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const PRISMA_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

const previousMigrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name < MIGRATION)
  .map((d) => d.name)
  .sort();

describeIfDb('migration emplacements_cote (base au format précédent)', () => {
  const prisma = new PrismaClient();
  const schemas: string[] = [];

  function execute(schema: string, sql: string): void {
    execFileSync(PRISMA_BIN, ['db', 'execute', '--stdin', '--url', process.env.DATABASE_URL!], {
      input: `SET search_path TO "${schema}", public;\n${sql}`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function previousFormat(): Promise<string> {
    const schema = `emplacements_cote_mig_${process.pid}_${schemas.length}`;
    schemas.push(schema);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const name of previousMigrations) execute(schema, migrationSql(name));
    return schema;
  }

  const migrate = (schema: string) => execute(schema, migrationSql(MIGRATION));
  const q = <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);
  /** Écriture dans `schema`, nom de la contrainte violée ajouté au message d'erreur. */
  const run = (schema: string, sql: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      return tx.$executeRawUnsafe(`
        DO $do$ BEGIN
          EXECUTE $sql$${sql}$sql$;
        EXCEPTION WHEN others THEN
          DECLARE constraint_name TEXT;
          BEGIN
            GET STACKED DIAGNOSTICS constraint_name = CONSTRAINT_NAME;
            RAISE EXCEPTION '% [contrainte : %]', SQLERRM, constraint_name;
          END;
        END $do$`);
    });

  afterAll(async () => {
    for (const schema of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  it('part bien du format précédent (multi_caves)', () => {
    expect(previousMigrations).not.toContain(MIGRATION);
    expect(previousMigrations[previousMigrations.length - 1]).toBe('20261012000000_multi_caves');
  });

  describe('base remplie comme en production', () => {
    let s: string;
    let snapshot: Record<string, unknown[]>;
    const snapshotQueries = (schema: string): Record<string, string> => ({
      wine: `SELECT * FROM "${schema}".wine ORDER BY id`,
      movement: `SELECT id, wine_id, delta, type::text AS type, photo_id, price_unit_cents, idempotency_key, occurred_at FROM "${schema}".movement ORDER BY id`,
      cave: `SELECT * FROM "${schema}".cave ORDER BY id`,
      cave_member: `SELECT * FROM "${schema}".cave_member ORDER BY id`,
      photo: `SELECT id, cave_id, content_hash, status::text AS status FROM "${schema}".photo ORDER BY id`,
      stock: `SELECT wine_id, quantity FROM "${schema}".stock_courant ORDER BY wine_id`,
    });

    beforeAll(async () => {
      s = await previousFormat();
      await run(s, `
        INSERT INTO "${s}".app_user (id, email, display_name, status, is_admin) VALUES
          ('u-franck', 'franck@example.com', 'Franck', 'ACTIVE', true),
          ('u-ami', 'ami@example.com', 'Ami', 'ACTIVE', false)`);
      await run(s, `
        INSERT INTO "${s}".cave (id, name, owner_id) VALUES
          ('cave-a', 'Cave de Franck', 'u-franck'),
          ('cave-b', 'Cave d’Ami', 'u-ami')`);
      await run(s, `
        INSERT INTO "${s}".cave_member (id, cave_id, user_id, role) VALUES
          ('cm-a', 'cave-a', 'u-franck', 'OWNER'),
          ('cm-b', 'cave-b', 'u-ami', 'OWNER')`);
      await run(s, `
        INSERT INTO "${s}".wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES
          ('w1', 'cave-a', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE'),
          ('w2', 'cave-a', 'trimbach|alsace|2020', 'Trimbach', 'Alsace', 'BLANC'),
          ('w3', 'cave-b', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE')`);
      await run(s, `
        INSERT INTO "${s}".photo (id, cave_id, content_hash, storage_path, status) VALUES
          ('p1', 'cave-a', 'hash-1', 'normalized/p1.jpg', 'DONE')`);
      await run(s, `
        INSERT INTO "${s}".movement (id, wine_id, delta, type, photo_id, price_unit_cents, idempotency_key) VALUES
          ('m1', 'w1', 6, 'IN', 'p1', 2500, 'k1'),
          ('m2', 'w1', -1, 'OUT', NULL, NULL, 'k2'),
          ('m3', 'w2', 3, 'IN', NULL, 1200, 'k3'),
          ('m4', 'w2', -1, 'ADJUST', NULL, NULL, 'k4'),
          ('m5', 'w3', 2, 'IN', NULL, NULL, 'k5')`);
      snapshot = {};
      for (const [k, sql] of Object.entries(snapshotQueries(s))) snapshot[k] = await q(sql);
      migrate(s);
    }, 120_000);

    it('laisse les données existantes intactes (vins, mouvements, caves, photos, stock)', async () => {
      for (const [k, sql] of Object.entries(snapshotQueries(s))) expect([k, await q(sql)]).toEqual([k, snapshot[k]]);
      expect(snapshot.stock).toEqual([
        { wine_id: 'w1', quantity: 5 },
        { wine_id: 'w2', quantity: 2 },
        { wine_id: 'w3', quantity: 2 },
      ]);
    });

    it('laisse toutes les bouteilles « Sans emplacement » (location_id nul partout)', async () => {
      const rows = await q<{ location_id: string | null }>(`SELECT location_id FROM "${s}".movement`);
      expect(rows.length).toBe(5);
      expect(rows.every((r) => r.location_id === null)).toBe(true);
      expect(await q(`SELECT id FROM "${s}".location`)).toEqual([]);
      expect(await q(`SELECT id FROM "${s}".price_quote`)).toEqual([]);
    });

    it('ajoute la valeur MOVE, utilisable une fois la migration validée ; la paire laisse le stock inchangé', async () => {
      const types = await q<{ v: string }>(`SELECT unnest(enum_range(NULL::"${s}"."MovementType"))::text AS v`);
      expect(types.map((r) => r.v)).toEqual(['IN', 'OUT', 'ADJUST', 'MOVE']);
      await run(s, `INSERT INTO "${s}".location (id, cave_id, zone, label_key) VALUES ('loc-move', 'cave-a', 'Cave 1', 'cave 1||')`);
      await run(s, `
        INSERT INTO "${s}".movement (id, wine_id, delta, type, location_id, idempotency_key) VALUES
          ('mv-out', 'w1', -2, 'MOVE', NULL, 'kmv-out'),
          ('mv-in', 'w1', 2, 'MOVE', 'loc-move', 'kmv-in')`);
      expect(await q(`SELECT quantity FROM "${s}".stock_courant WHERE wine_id = 'w1'`)).toEqual([{ quantity: 5 }]);
    });

    it('rend l’emplacement unique par cave, mais deux caves peuvent avoir le même', async () => {
      await run(s, `INSERT INTO "${s}".location (id, cave_id, zone, casier, position, label_key) VALUES ('loc-a', 'cave-a', 'Cave 2', 'B', '3', 'cave 2|b|3')`);
      await run(s, `INSERT INTO "${s}".location (id, cave_id, zone, casier, position, label_key) VALUES ('loc-b', 'cave-b', 'Cave 2', 'B', '3', 'cave 2|b|3')`);
      await expect(
        run(s, `INSERT INTO "${s}".location (id, cave_id, zone, casier, position, label_key) VALUES ('loc-dup', 'cave-a', 'cave 2', 'b', '3', 'cave 2|b|3')`),
      ).rejects.toThrow(/location_cave_id_label_key_key/);
      await expect(
        run(s, `INSERT INTO "${s}".location (id, cave_id, zone, label_key) VALUES ('loc-x', 'inexistante', 'Z', 'z||')`),
      ).rejects.toThrow(/location_cave_id_fkey/);
    });

    it('refuse un emplacement sans zone, casier ni position', async () => {
      await expect(
        run(s, `INSERT INTO "${s}".location (id, cave_id, label_key) VALUES ('loc-vide', 'cave-a', '||')`),
      ).rejects.toThrow(/location_not_empty_check/);
    });

    it('relie un mouvement à un emplacement et empêche de supprimer un emplacement utilisé', async () => {
      await run(s, `INSERT INTO "${s}".movement (id, wine_id, delta, type, location_id, idempotency_key) VALUES ('m-loc', 'w2', 1, 'IN', 'loc-a', 'k-loc')`);
      await expect(run(s, `DELETE FROM "${s}".location WHERE id = 'loc-a'`)).rejects.toThrow(/movement_location_id_fkey/);
      await expect(
        run(s, `INSERT INTO "${s}".movement (id, wine_id, delta, type, location_id, idempotency_key) VALUES ('m-bad', 'w2', 1, 'IN', 'inexistant', 'k-bad')`),
      ).rejects.toThrow(/movement_location_id_fkey/);
    });

    it('enregistre une cote (source IDEALWINE par défaut) et refuse une cote nulle ou un nombre de transactions négatif', async () => {
      await run(s, `
        INSERT INTO "${s}".price_quote (id, wine_id, cote_cents, n_transactions, quoted_on, source_url, entered_by) VALUES
          ('q1', 'w1', 8500, 12, '2026-03-03', 'https://www.idealwine.com/fr/x', 'u-franck')`);
      expect(await q(`SELECT source, cote_cents, n_transactions, quoted_on::text AS quoted_on FROM "${s}".price_quote WHERE id = 'q1'`)).toEqual([
        { source: 'IDEALWINE', cote_cents: 8500, n_transactions: 12, quoted_on: '2026-03-03' },
      ]);
      await expect(
        run(s, `INSERT INTO "${s}".price_quote (id, wine_id, cote_cents, quoted_on) VALUES ('q-zero', 'w1', 0, '2026-03-03')`),
      ).rejects.toThrow(/price_quote_cote_cents_check/);
      await expect(
        run(s, `INSERT INTO "${s}".price_quote (id, wine_id, cote_cents, n_transactions, quoted_on) VALUES ('q-neg', 'w1', 100, -1, '2026-03-03')`),
      ).rejects.toThrow(/price_quote_n_transactions_check/);
      // Sans nombre de transactions : accepté.
      await run(s, `INSERT INTO "${s}".price_quote (id, wine_id, cote_cents, quoted_on) VALUES ('q-null', 'w1', 100, '2026-03-04')`);
    });

    it('garde la cote quand le compte qui l’a saisie disparaît (entered_by nul)', async () => {
      await run(s, `INSERT INTO "${s}".app_user (id, email, status) VALUES ('u-temp', 'temp@example.com', 'ACTIVE')`);
      await run(s, `INSERT INTO "${s}".price_quote (id, wine_id, cote_cents, quoted_on, entered_by) VALUES ('q-temp', 'w2', 500, '2026-01-01', 'u-temp')`);
      await run(s, `DELETE FROM "${s}".app_user WHERE id = 'u-temp'`);
      expect(await q(`SELECT entered_by FROM "${s}".price_quote WHERE id = 'q-temp'`)).toEqual([{ entered_by: null }]);
    });

    it('supprime les cotes d’un vin supprimé', async () => {
      await run(s, `INSERT INTO "${s}".wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES ('w-del', 'cave-a', 'del', 'P', 'A', 'ROUGE')`);
      await run(s, `INSERT INTO "${s}".price_quote (id, wine_id, cote_cents, quoted_on) VALUES ('q-del', 'w-del', 100, '2026-01-01')`);
      await run(s, `DELETE FROM "${s}".wine WHERE id = 'w-del'`);
      expect(await q(`SELECT id FROM "${s}".price_quote WHERE wine_id = 'w-del'`)).toEqual([]);
    });
  });

  it('installation neuve (base vide) : la migration passe', async () => {
    const s = await previousFormat();
    migrate(s);
    expect(await q(`SELECT id FROM "${s}".location`)).toEqual([]);
    expect(await q(`SELECT id FROM "${s}".price_quote`)).toEqual([]);
  }, 120_000);
});
