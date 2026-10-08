import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migration « zones » éprouvée sur une base au format précédent, remplie comme
 * en production (2.2.0 à 2.5.0) : zones saisies en texte libre, avec des
 * graphies qui ne diffèrent que par la casse ou les espaces, et des mouvements
 * rangés à ces emplacements.
 *
 * Même approche que emplacements-cote.migration.integration.spec.ts : un schéma
 * PostgreSQL dédié dans la base de test, toutes les migrations précédentes, puis
 * le SQL de la nouvelle migration tel qu'il est livré, en un seul envoi. Le
 * schéma est supprimé à la fin ; le schéma `public` n'est jamais touché.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const MIGRATION = '20261015000000_zones';
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const PRISMA_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

const previousMigrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name < MIGRATION)
  .map((d) => d.name)
  .sort();

describeIfDb('migration zones (base au format précédent)', () => {
  const prisma = new PrismaClient();
  const schemas: string[] = [];

  function execute(schema: string, sql: string): void {
    execFileSync(PRISMA_BIN, ['db', 'execute', '--stdin', '--url', process.env.DATABASE_URL!], {
      input: `SET search_path TO "${schema}", public;\n${sql}`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function previousFormat(): Promise<string> {
    const schema = `zones_mig_${process.pid}_${schemas.length}`;
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

  it('part bien du format précédent (gemini_call)', () => {
    expect(previousMigrations).not.toContain(MIGRATION);
    expect(previousMigrations[previousMigrations.length - 1]).toBe('20261014000000_gemini_call');
  });

  describe('base remplie comme en production', () => {
    let s: string;
    /** Stock par (vin, emplacement), décrit par l'identifiant de l'emplacement : il ne doit pas bouger. */
    const stockByLocation = (schema: string) =>
      q(`SELECT wine_id, location_id, SUM(delta)::INTEGER AS quantity FROM "${schema}".movement GROUP BY wine_id, location_id ORDER BY wine_id, location_id NULLS FIRST`);
    const stock = (schema: string) => q(`SELECT wine_id, quantity FROM "${schema}".stock_courant ORDER BY wine_id`);
    let before: { byLocation: unknown[]; stock: unknown[]; movements: unknown[]; locations: unknown[] };

    beforeAll(async () => {
      s = await previousFormat();
      await run(s, `
        INSERT INTO "${s}".app_user (id, email, display_name, status) VALUES
          ('u-franck', 'franck@example.com', 'Franck', 'ACTIVE'),
          ('u-ami', 'ami@example.com', 'Ami', 'ACTIVE')`);
      await run(s, `INSERT INTO "${s}".cave (id, name, owner_id) VALUES ('cave-a', 'Cave de Franck', 'u-franck'), ('cave-b', 'Cave d’Ami', 'u-ami')`);
      await run(s, `
        INSERT INTO "${s}".wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES
          ('w1', 'cave-a', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE'),
          ('w2', 'cave-a', 'trimbach|alsace|2020', 'Trimbach', 'Alsace', 'BLANC'),
          ('w3', 'cave-b', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE')`);
      // Clés au format de la 2.2.0 (tableau JSON des trois champs en minuscules, sans espaces).
      // « Cave 1 » / B et « cave 1 » / C : deux graphies d'une même zone, deux emplacements distincts.
      await run(s, `
        INSERT INTO "${s}".location (id, cave_id, zone, casier, position, label_key, created_at) VALUES
          ('l-c1-b', 'cave-a', 'Cave 1', 'B', '3', '["cave 1","b","3"]', '2026-01-01'),
          ('l-c1-c', 'cave-a', 'cave 1', 'C', NULL, '["cave 1","c",null]', '2026-01-02'),
          ('l-c1', 'cave-a', 'CAVE 1', NULL, NULL, '["cave 1",null,null]', '2026-01-03'),
          ('l-garage', 'cave-a', 'Garage', NULL, '12', '["garage",null,"12"]', '2026-01-04'),
          ('l-sans-zone', 'cave-a', NULL, 'Z', NULL, '[null,"z",null]', '2026-01-05'),
          ('l-b-cave', 'cave-b', 'Cave 1', 'B', '3', '["cave 1","b","3"]', '2026-01-06'),
          ('l-b-cellier', 'cave-b', ' Cellier ', NULL, NULL, '["cellier",null,null]', '2026-01-07')`);
      await run(s, `
        INSERT INTO "${s}".movement (id, wine_id, delta, type, location_id, idempotency_key) VALUES
          ('m1', 'w1', 6, 'IN', 'l-c1-b', 'k1'),
          ('m2', 'w1', -1, 'OUT', 'l-c1-b', 'k2'),
          ('m3', 'w1', 2, 'IN', 'l-c1-c', 'k3'),
          ('m4', 'w1', 1, 'IN', NULL, 'k4'),
          ('m5', 'w2', 3, 'IN', 'l-garage', 'k5'),
          ('m6', 'w2', 1, 'IN', 'l-sans-zone', 'k6'),
          ('m7', 'w2', 2, 'IN', 'l-c1', 'k7'),
          ('m8', 'w2', -2, 'OUT', 'l-c1', 'k8'),
          ('m9', 'w3', 4, 'IN', 'l-b-cave', 'k9'),
          ('m10', 'w3', 1, 'IN', 'l-b-cellier', 'k10')`);
      before = {
        byLocation: await stockByLocation(s),
        stock: await stock(s),
        movements: await q(`SELECT id, wine_id, delta, type::text AS type, location_id, idempotency_key FROM "${s}".movement ORDER BY id`),
        locations: await q(`SELECT id, cave_id, casier, position FROM "${s}".location ORDER BY id`),
      };
      migrate(s);
    }, 120_000);

    it('crée une zone par cave et par nom distinct (espaces et casse ignorés), en gardant une graphie saisie, triées par nom', async () => {
      const zones = await q<{ cave_id: string; name: string; sort_order: number; indication: string | null; photo_path: string | null; archived_at: Date | null }>(
        `SELECT cave_id, name, sort_order, indication, photo_path, archived_at FROM "${s}".cave_zone ORDER BY cave_id, sort_order`,
      );
      expect(zones).toEqual([
        // Graphie de l'emplacement le plus ancien.
        { cave_id: 'cave-a', name: 'Cave 1', sort_order: 0, indication: null, photo_path: null, archived_at: null },
        { cave_id: 'cave-a', name: 'Garage', sort_order: 1, indication: null, photo_path: null, archived_at: null },
        { cave_id: 'cave-b', name: 'Cave 1', sort_order: 0, indication: null, photo_path: null, archived_at: null },
        { cave_id: 'cave-b', name: 'Cellier', sort_order: 1, indication: null, photo_path: null, archived_at: null },
      ]);
      const ids = await q<{ id: string }>(`SELECT id FROM "${s}".cave_zone`);
      expect(ids.every((z) => /^[0-9a-f-]{36}$/.test(z.id))).toBe(true);
    });

    it('rattache chaque emplacement à la zone de sa cave ; sans zone, zone_id reste nul', async () => {
      const rows = await q<{ id: string; zone_cave: string | null; zone_name: string | null; location_cave: string }>(`
        SELECT l.id, l.cave_id AS location_cave, z.cave_id AS zone_cave, z.name AS zone_name
        FROM "${s}".location l LEFT JOIN "${s}".cave_zone z ON z.id = l.zone_id ORDER BY l.id`);
      expect(rows.map((r) => [r.id, r.zone_name])).toEqual([
        ['l-b-cave', 'Cave 1'],
        ['l-b-cellier', 'Cellier'],
        ['l-c1', 'Cave 1'],
        ['l-c1-b', 'Cave 1'],
        ['l-c1-c', 'Cave 1'],
        ['l-garage', 'Garage'],
        ['l-sans-zone', null],
      ]);
      expect(rows.filter((r) => r.zone_cave != null).every((r) => r.zone_cave === r.location_cave)).toBe(true);
      // Une autre cave a sa propre « Cave 1 ».
      const [a] = await q<{ zone_id: string }>(`SELECT zone_id FROM "${s}".location WHERE id = 'l-c1-b'`);
      const [b] = await q<{ zone_id: string }>(`SELECT zone_id FROM "${s}".location WHERE id = 'l-b-cave'`);
      expect(a.zone_id).not.toBe(b.zone_id);
    });

    it('ne perd rien : mêmes mouvements, mêmes emplacements (casier, position), même stock par emplacement', async () => {
      expect(await stockByLocation(s)).toEqual(before.byLocation);
      expect(await stock(s)).toEqual(before.stock);
      expect(await q(`SELECT id, wine_id, delta, type::text AS type, location_id, idempotency_key FROM "${s}".movement ORDER BY id`)).toEqual(before.movements);
      expect(await q(`SELECT id, cave_id, casier, position FROM "${s}".location ORDER BY id`)).toEqual(before.locations);
    });

    it('le texte de zone et la clé JSON disparaissent : le libellé vient du nom de la zone', async () => {
      const columns = await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = '${s}' AND table_name = 'location' ORDER BY column_name`,
      );
      expect(columns.map((c) => c.column_name)).toEqual(['casier', 'cave_id', 'created_at', 'id', 'position', 'zone_id']);
    });

    it('emplacement unique par (cave, zone, casier et position en minuscules) ; une autre cave reste à part', async () => {
      const [{ id: cave1 }] = await q<{ id: string }>(`SELECT id FROM "${s}".cave_zone WHERE cave_id = 'cave-a' AND name = 'Cave 1'`);
      await expect(
        run(s, `INSERT INTO "${s}".location (id, cave_id, zone_id, casier, position) VALUES ('dup', 'cave-a', '${cave1}', 'b', '3')`),
      ).rejects.toThrow(/location_place_key/);
      await expect(
        run(s, `INSERT INTO "${s}".location (id, cave_id, zone_id) VALUES ('dup2', 'cave-a', '${cave1}')`),
      ).rejects.toThrow(/location_place_key/);
      await expect(run(s, `INSERT INTO "${s}".location (id, cave_id, casier) VALUES ('dup3', 'cave-a', 'z')`)).rejects.toThrow(/location_place_key/);
      // Même casier et position, autre cave ou sans zone : accepté.
      await run(s, `INSERT INTO "${s}".location (id, cave_id, casier, position) VALUES ('ok1', 'cave-a', 'B', '3')`);
      await run(s, `INSERT INTO "${s}".location (id, cave_id, casier) VALUES ('ok2', 'cave-b', 'Z')`);
    });

    it('refuse un emplacement vide, une zone inconnue, et la suppression d’une zone encore désignée', async () => {
      await expect(run(s, `INSERT INTO "${s}".location (id, cave_id) VALUES ('vide', 'cave-a')`)).rejects.toThrow(/location_not_empty_check/);
      await expect(run(s, `INSERT INTO "${s}".location (id, cave_id, zone_id) VALUES ('x', 'cave-a', 'inconnue')`)).rejects.toThrow(/location_zone_id_fkey/);
      await expect(run(s, `DELETE FROM "${s}".cave_zone WHERE name = 'Garage'`)).rejects.toThrow(/location_zone_id_fkey/);
    });

    it('nom de zone unique par cave sans tenir compte de la casse, réutilisable une fois la zone archivée', async () => {
      await expect(run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name) VALUES ('z-dup', 'cave-a', 'GARAGE')`)).rejects.toThrow(/cave_zone_cave_id_name_key/);
      await run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name) VALUES ('z-b', 'cave-b', 'Garage')`);
      await run(s, `UPDATE "${s}".cave_zone SET archived_at = now() WHERE id = 'z-b'`);
      await run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name) VALUES ('z-b2', 'cave-b', 'garage')`);
      const [{ created_at }] = await q<{ created_at: Date }>(`SELECT created_at FROM "${s}".cave_zone WHERE id = 'z-b2'`);
      expect(Math.abs(created_at.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it('bornes du nom (1 à 40) et de l’indication (300), cave obligatoire', async () => {
      await expect(run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name) VALUES ('z-vide', 'cave-a', '')`)).rejects.toThrow(/cave_zone_name_length_check/);
      await expect(run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name) VALUES ('z-long', 'cave-a', '${'a'.repeat(41)}')`)).rejects.toThrow(/cave_zone_name_length_check/);
      await expect(
        run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name, indication) VALUES ('z-ind', 'cave-a', 'Ind', '${'a'.repeat(301)}')`),
      ).rejects.toThrow(/cave_zone_indication_length_check/);
      await run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name, indication) VALUES ('z-ind-ok', 'cave-a', 'Ind', '${'a'.repeat(300)}')`);
      await expect(run(s, `INSERT INTO "${s}".cave_zone (id, cave_id, name) VALUES ('z-x', 'inexistante', 'X')`)).rejects.toThrow(/cave_zone_cave_id_fkey/);
      await expect(run(s, `DELETE FROM "${s}".cave WHERE id = 'cave-a'`)).rejects.toThrow(/fkey/);
    });
  });

  it('emplacement sans zone, casier ni position (champs blancs) : la migration s’arrête en le nommant, sans rien changer', async () => {
    const s = await previousFormat();
    await run(s, `INSERT INTO "${s}".cave (id, name) VALUES ('cave-x', 'Cave X')`);
    await run(s, `INSERT INTO "${s}".location (id, cave_id, zone, casier, label_key) VALUES ('loc-blanc', 'cave-x', '  ', '', '["",""]')`);
    expect(() => migrate(s)).toThrow(/emplacement loc-blanc n'a ni zone, ni casier, ni position/);
    // Annulée en entier : ni table de zones, ni colonne retirée.
    expect(await q(`SELECT to_regclass('"${s}".cave_zone')::text AS t`)).toEqual([{ t: null }]);
    expect(await q(`SELECT zone FROM "${s}".location WHERE id = 'loc-blanc'`)).toEqual([{ zone: '  ' }]);
  }, 120_000);

  it('installation neuve (base vide) : la migration passe', async () => {
    const s = await previousFormat();
    migrate(s);
    expect(await q(`SELECT id FROM "${s}".cave_zone`)).toEqual([]);
  }, 120_000);
});
