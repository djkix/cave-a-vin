import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migration « une cave par compte » éprouvée sur une base au format précédent.
 *
 * Choix : chaque scénario crée un schéma PostgreSQL dédié dans la base de test,
 * y applique toutes les migrations précédentes, y insère des données comme en
 * production, puis applique le SQL de la nouvelle migration tel qu'il est livré
 * — en un seul envoi, comme `prisma migrate deploy`, donc dans une transaction
 * (ce qui vérifie aussi que la valeur d'enum PENDING n'y est pas employée).
 * Le SQL passe par `prisma db execute` (déjà une dépendance) : le client Prisma
 * n'accepte qu'une instruction par requête. Le schéma est supprimé à la fin ;
 * le schéma `public` de la base de test n'est jamais touché.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const MIGRATION = '20261012000000_multi_caves';
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const PRISMA_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

const previousMigrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name < MIGRATION)
  .map((d) => d.name)
  .sort();

describeIfDb('migration multi_caves (base au format précédent)', () => {
  const prisma = new PrismaClient();
  const schemas: string[] = [];

  /** Exécute un script SQL complet dans `schema` (les extensions restent dans public). */
  function execute(schema: string, sql: string): void {
    execFileSync(PRISMA_BIN, ['db', 'execute', '--stdin', '--url', process.env.DATABASE_URL!], {
      // Fuseau de session volontairement éloigné d'UTC : les dates écrites par la
      // migration doivent rester en UTC, comme celles que Prisma écrit.
      input: `SET search_path TO "${schema}", public;\nSET TIME ZONE 'Pacific/Kiritimati';\n${sql}`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Nouveau schéma au format de la version précédente (toutes les migrations sauf la nouvelle). */
  async function previousFormat(): Promise<string> {
    const schema = `multi_caves_mig_${process.pid}_${schemas.length}`;
    schemas.push(schema);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    // Une migration par transaction, comme elles ont été appliquées en production.
    for (const name of previousMigrations) execute(schema, migrationSql(name));
    return schema;
  }

  const migrate = (schema: string) => execute(schema, migrationSql(MIGRATION));
  const q = <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);
  /**
   * Écriture dans `schema` : les déclencheurs (stock jamais négatif) nomment
   * leurs tables sans schéma et les résolvent par le search_path de la session.
   */
  const run = (schema: string, sql: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      // Le message d'erreur que Prisma remonte omet le nom de la contrainte :
      // on le fait figurer dans le message, avec le texte de PostgreSQL.
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

  it('part bien du format précédent (aucune colonne cave_id)', async () => {
    expect(previousMigrations.length).toBeGreaterThan(10);
    expect(previousMigrations).not.toContain(MIGRATION);
    expect(previousMigrations[previousMigrations.length - 1]).toBe('20261011000000_image_reference');
  });

  describe('base remplie comme en production', () => {
    let s: string;

    beforeAll(async () => {
      s = await previousFormat();
      await run(s, `
        INSERT INTO "${s}".app_user (id, email, display_name, is_break_glass, status, is_admin, created_at) VALUES
          ('u-secours', 'secours@example.com', NULL, true, 'ACTIVE', true, '2026-01-01'),
          ('u-franck', 'franck@example.com', 'Franck', false, 'ACTIVE', true, '2026-02-01'),
          ('u-admin2', 'admin2@example.com', 'Second admin', false, 'ACTIVE', true, '2026-03-01'),
          ('u-ami', 'ami@example.com', 'Ami', false, 'ACTIVE', false, '2026-01-15'),
          ('u-bloque', 'bloque@example.com', 'Bloqué', false, 'BLOCKED', false, '2026-01-20')`);
      await run(s, `
        INSERT INTO "${s}".wine (id, match_key, producer, appellation_raw, color, rating, rated_at, rated_by) VALUES
          ('w1', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE', 16.5, now(), 'u-franck'),
          ('w2', 'trimbach|alsace|2020', 'Trimbach', 'Alsace', 'BLANC', NULL, NULL, NULL)`);
      await run(s, `
        INSERT INTO "${s}".photo (id, content_hash, storage_path, status, purpose) VALUES
          ('p1', 'hash-1', 'normalized/p1.jpg', 'DONE', 'ENTRY'),
          ('p2', 'hash-2', 'normalized/p2.jpg', 'PENDING', 'EXIT'),
          ('p3', 'reference:p3', 'normalized/p3.jpg', 'DONE', 'REFERENCE')`);
      await run(s, `
        INSERT INTO "${s}".movement (id, wine_id, delta, type, photo_id, price_unit_cents, idempotency_key) VALUES
          ('m1', 'w1', 6, 'IN', 'p1', 2500, 'k1'),
          ('m2', 'w1', -1, 'OUT', NULL, NULL, 'k2'),
          ('m3', 'w2', 3, 'IN', NULL, 1200, 'k3')`);
      await run(s, `UPDATE "${s}".wine SET reference_photo_id = 'p3' WHERE id = 'w1'`);
      await run(s, `
        INSERT INTO "${s}".export_log (id, user_id, row_count) VALUES ('e1', 'u-franck', 2)`);
      await run(s, `
        INSERT INTO "${s}".image_search_cost (id, wine_id, model, cost_cents) VALUES ('c1', 'w1', 'gemini', 1)`);
      migrate(s);
    }, 120_000);

    it('crée une seule cave, celle du premier administrateur qui n’est pas le compte de secours', async () => {
      const caves = await q<{ id: string; name: string; owner_id: string }>(`SELECT id, name, owner_id FROM "${s}".cave`);
      expect(caves).toEqual([{ id: expect.any(String), name: 'Cave de Franck', owner_id: 'u-franck' }]);
    });

    it('date la cave et ses accès en UTC, comme Prisma (sinon une cave créée ensuite paraîtrait plus ancienne)', async () => {
      const rows = await q<{ drift: number }>(`
        SELECT abs(extract(epoch FROM created_at - (now() AT TIME ZONE 'UTC'))) AS drift FROM "${s}".cave
        UNION ALL
        SELECT abs(extract(epoch FROM created_at - (now() AT TIME ZONE 'UTC'))) FROM "${s}".cave_member`);
      expect(rows.length).toBe(5);
      for (const r of rows) expect(Number(r.drift)).toBeLessThan(300);
    });

    it('rattache toutes les lignes existantes à cette cave', async () => {
      const [{ id }] = await q<{ id: string }>(`SELECT id FROM "${s}".cave`);
      for (const table of ['wine', 'photo', 'export_log', 'image_search_cost']) {
        const rows = await q<{ cave_id: string }>(`SELECT cave_id FROM "${s}".${table}`);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.cave_id === id)).toBe(true);
      }
      // Rien d'autre ne bouge : mouvements, vignette et note sont intacts.
      const stock = await q<{ wine_id: string; quantity: number }>(`SELECT wine_id, quantity FROM "${s}".stock_courant ORDER BY wine_id`);
      expect(stock).toEqual([{ wine_id: 'w1', quantity: 5 }, { wine_id: 'w2', quantity: 3 }]);
      const [w1] = await q<{ reference_photo_id: string; rated_by: string }>(`SELECT reference_photo_id, rated_by FROM "${s}".wine WHERE id = 'w1'`);
      expect(w1).toEqual({ reference_photo_id: 'p3', rated_by: 'u-franck' });
    });

    it('fait du propriétaire une ligne OWNER et des autres comptes actifs des membres VIEWER', async () => {
      const members = await q<{ user_id: string; role: string; invited_email: string | null }>(
        `SELECT user_id, role::text AS role, invited_email FROM "${s}".cave_member ORDER BY role, user_id`,
      );
      expect(members).toEqual([
        { user_id: 'u-franck', role: 'OWNER', invited_email: null },
        { user_id: 'u-admin2', role: 'VIEWER', invited_email: null },
        { user_id: 'u-ami', role: 'VIEWER', invited_email: null },
        { user_id: 'u-secours', role: 'VIEWER', invited_email: null },
      ]);
    });

    it('ajoute le réglage de part de budget par cave (0,2)', async () => {
      expect(await q(`SELECT key, value FROM "${s}".app_setting`)).toEqual([{ key: 'cave_budget_share', value: '0.2' }]);
    });

    it('ajoute le statut PENDING et le rôle de cave', async () => {
      const status = await q<{ v: string }>(`SELECT unnest(enum_range(NULL::"${s}"."AccountStatus"))::text AS v`);
      expect(status.map((r) => r.v)).toEqual(['PENDING', 'ACTIVE', 'BLOCKED']);
      const roles = await q<{ v: string }>(`SELECT unnest(enum_range(NULL::"${s}"."CaveRole"))::text AS v`);
      expect(roles.map((r) => r.v)).toEqual(['OWNER', 'VIEWER']);
      // Utilisable une fois la migration validée.
      await run(s, `UPDATE "${s}".app_user SET status = 'PENDING' WHERE id = 'u-bloque'`);
    });

    it('refuse désormais une ligne sans cave', async () => {
      await expect(
        run(s, `INSERT INTO "${s}".wine (id, match_key, producer, appellation_raw, color) VALUES ('w-x', 'x', 'X', 'X', 'ROUGE')`),
      ).rejects.toThrow(/cave_id/);
      await expect(
        run(s, `INSERT INTO "${s}".photo (id, content_hash, storage_path) VALUES ('p-x', 'x', 'x')`),
      ).rejects.toThrow(/cave_id/);
      await expect(run(s, `INSERT INTO "${s}".export_log (id, user_id, row_count) VALUES ('e-x', 'u', 0)`)).rejects.toThrow(/cave_id/);
      await expect(run(s, `INSERT INTO "${s}".image_search_cost (id, cost_cents) VALUES ('c-x', 0)`)).rejects.toThrow(/cave_id/);
      await expect(
        run(s, `INSERT INTO "${s}".wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES ('w-y', 'inexistante', 'y', 'Y', 'Y', 'ROUGE')`),
      ).rejects.toThrow(/wine_cave_id_fkey/);
    });

    it('pose les unicités par cave : même vin et même image permis dans une autre cave, jamais deux fois dans la même', async () => {
      const [{ id }] = await q<{ id: string }>(`SELECT id FROM "${s}".cave`);
      await run(s, `INSERT INTO "${s}".cave (id, name, owner_id) VALUES ('cave-b', 'Cave B', 'u-admin2')`);
      await run(s, `INSERT INTO "${s}".wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES ('w1-b', 'cave-b', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE')`,
      );
      await run(s, `INSERT INTO "${s}".photo (id, cave_id, content_hash, storage_path) VALUES ('p1-b', 'cave-b', 'hash-1', 'x')`);
      await expect(
        run(s, `INSERT INTO "${s}".wine (id, cave_id, match_key, producer, appellation_raw, color) VALUES ('w1-dup', '${id}', 'tempier|bandol|2019', 'Domaine Tempier', 'Bandol', 'ROUGE')`,
        ),
      ).rejects.toThrow(/wine_cave_id_match_key_key/);
      await expect(
        run(s, `INSERT INTO "${s}".photo (id, cave_id, content_hash, storage_path) VALUES ('p1-dup', '${id}', 'hash-1', 'x')`),
      ).rejects.toThrow(/photo_cave_id_content_hash_key/);
      // La clé d'idempotence des mouvements reste unique pour toutes les caves.
      await expect(
        run(s, `INSERT INTO "${s}".movement (id, wine_id, delta, type, idempotency_key) VALUES ('m-dup', 'w1-b', 1, 'IN', 'k1')`),
      ).rejects.toThrow(/movement_idempotency_key_key/);
    });

    it('n’accepte qu’un propriétaire par cave et un seul accès par compte ou adresse', async () => {
      const [{ id }] = await q<{ id: string }>(`SELECT id FROM "${s}".cave WHERE id <> 'cave-b'`);
      await expect(
        run(s, `INSERT INTO "${s}".cave_member (id, cave_id, user_id, role) VALUES ('cm-x', '${id}', 'u-bloque', 'OWNER')`),
      ).rejects.toThrow(/cave_member_one_owner_idx/);
      await expect(
        run(s, `INSERT INTO "${s}".cave_member (id, cave_id, user_id, role) VALUES ('cm-y', '${id}', 'u-ami', 'VIEWER')`),
      ).rejects.toThrow(/cave_member_cave_id_user_id_key/);
      await run(s, `INSERT INTO "${s}".cave_member (id, cave_id, invited_email, role) VALUES ('cm-i', '${id}', 'invite@example.com', 'VIEWER')`);
      await expect(
        run(s, `INSERT INTO "${s}".cave_member (id, cave_id, invited_email, role) VALUES ('cm-j', '${id}', 'invite@example.com', 'VIEWER')`),
      ).rejects.toThrow(/cave_member_cave_id_invited_email_key/);
      // Ni ligne vide, ni propriétaire qui ne serait qu'une invitation.
      await expect(
        run(s, `INSERT INTO "${s}".cave_member (id, cave_id, role) VALUES ('cm-k', '${id}', 'VIEWER')`),
      ).rejects.toThrow(/cave_member_target_check/);
      await expect(
        run(s, `INSERT INTO "${s}".cave_member (id, cave_id, invited_email, role) VALUES ('cm-l', 'cave-b', 'x@example.com', 'OWNER')`),
      ).rejects.toThrow(/cave_member_owner_user_check/);
      // Le propriétaire d'une autre cave reste possible.
      await run(s, `INSERT INTO "${s}".cave_member (id, cave_id, user_id, role) VALUES ('cm-b', 'cave-b', 'u-admin2', 'OWNER')`);
    });
  });

  it('installation neuve (base vide) : aucune cave créée, le réglage existe', async () => {
    const s = await previousFormat();
    migrate(s);
    expect(await q(`SELECT id FROM "${s}".cave`)).toEqual([]);
    expect(await q(`SELECT id FROM "${s}".cave_member`)).toEqual([]);
    expect(await q(`SELECT key, value FROM "${s}".app_setting`)).toEqual([{ key: 'cave_budget_share', value: '0.2' }]);
  }, 120_000);

  it('seul le compte de secours : il devient propriétaire (nommé par son adresse)', async () => {
    const s = await previousFormat();
    await run(s, `
      INSERT INTO "${s}".app_user (id, email, display_name, is_break_glass, status, is_admin, created_at) VALUES
        ('u-secours', 'secours@example.com', '  ', true, 'ACTIVE', false, '2026-01-01'),
        ('u-bloque', 'bloque@example.com', NULL, false, 'BLOCKED', true, '2025-01-01')`);
    await run(s, `INSERT INTO "${s}".wine (id, match_key, producer, appellation_raw, color) VALUES ('w1', 'k', 'P', 'A', 'ROUGE')`);
    migrate(s);
    const caves = await q(`SELECT name, owner_id FROM "${s}".cave`);
    expect(caves).toEqual([{ name: 'Cave de secours@example.com', owner_id: 'u-secours' }]);
    expect(await q(`SELECT user_id, role::text AS role FROM "${s}".cave_member`)).toEqual([{ user_id: 'u-secours', role: 'OWNER' }]);
  }, 120_000);

  it('données sans aucun compte : cave sans propriétaire, toutes les lignes rattachées', async () => {
    const s = await previousFormat();
    await run(s, `INSERT INTO "${s}".wine (id, match_key, producer, appellation_raw, color) VALUES ('w1', 'k', 'P', 'A', 'ROUGE')`);
    await run(s, `INSERT INTO "${s}".photo (id, content_hash, storage_path) VALUES ('p1', 'h', 'x')`);
    migrate(s);
    const caves = await q<{ id: string; name: string; owner_id: string | null }>(`SELECT id, name, owner_id FROM "${s}".cave`);
    expect(caves).toEqual([{ id: expect.any(String), name: 'Ma cave', owner_id: null }]);
    expect(await q(`SELECT cave_id FROM "${s}".wine`)).toEqual([{ cave_id: caves[0].id }]);
    expect(await q(`SELECT cave_id FROM "${s}".photo`)).toEqual([{ cave_id: caves[0].id }]);
    expect(await q(`SELECT id FROM "${s}".cave_member`)).toEqual([]);
  }, 120_000);
});
