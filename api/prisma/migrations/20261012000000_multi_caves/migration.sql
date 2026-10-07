-- Une cave par compte : chaque compte a sa propre cave, des membres peuvent y
-- être invités en lecture seule, et une inscription Google attend la validation
-- d'un administrateur. Toute la migration s'exécute dans une seule transaction
-- (prisma migrate deploy envoie le script d'un bloc) : si une étape échoue,
-- rien n'est modifié.
--
-- SAUVEGARDER LA BASE AVANT LA MISE À JOUR.

-- 1. Statut « en attente ». La valeur ajoutée n'est utilisée par aucune requête
-- de cette migration : PostgreSQL interdit d'employer une valeur d'enum dans la
-- transaction qui l'a créée.
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'PENDING' BEFORE 'ACTIVE';

CREATE TYPE "CaveRole" AS ENUM ('OWNER', 'VIEWER');

-- 2. Caves et accès.
CREATE TABLE "cave" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- NULL seulement pour une cave migrée sur une base sans aucun compte : elle
  -- sera attribuée au premier administrateur qui se connecte.
  "owner_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cave_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cave_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "cave_owner_id_idx" ON "cave"("owner_id");

CREATE TABLE "cave_member" (
  "id" TEXT NOT NULL,
  "cave_id" TEXT NOT NULL,
  -- Compte rattaché, ou NULL tant que l'adresse invitée ne s'est pas connectée.
  "user_id" TEXT,
  "invited_email" TEXT,
  "role" "CaveRole" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cave_member_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cave_member_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cave_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Une ligne désigne toujours quelqu'un : un compte ou une adresse invitée.
  CONSTRAINT "cave_member_target_check" CHECK ("user_id" IS NOT NULL OR "invited_email" IS NOT NULL),
  -- Le propriétaire est un compte, jamais une simple invitation.
  CONSTRAINT "cave_member_owner_user_check" CHECK ("role" <> 'OWNER' OR "user_id" IS NOT NULL)
);
-- Les NULL ne se heurtent pas : plusieurs invitations en attente (user_id NULL)
-- et plusieurs comptes rattachés (invited_email NULL) coexistent dans une cave.
CREATE UNIQUE INDEX "cave_member_cave_id_user_id_key" ON "cave_member"("cave_id", "user_id");
CREATE UNIQUE INDEX "cave_member_cave_id_invited_email_key" ON "cave_member"("cave_id", "invited_email");
CREATE INDEX "cave_member_user_id_idx" ON "cave_member"("user_id");
CREATE INDEX "cave_member_invited_email_idx" ON "cave_member"("invited_email");
-- Un seul propriétaire par cave, vrai même sous concurrence.
CREATE UNIQUE INDEX "cave_member_one_owner_idx" ON "cave_member"("cave_id") WHERE "role" = 'OWNER';

-- 3. Réglages d'administration. Part maximale du plafond Gemini mensuel qu'une
-- cave (autre que celle du premier administrateur) peut consommer.
CREATE TABLE "app_setting" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);
INSERT INTO "app_setting" ("key", "value") VALUES ('cave_budget_share', '0.2');

-- 4. Rattachement à une cave, d'abord sans contrainte pour pouvoir remplir.
ALTER TABLE "wine" ADD COLUMN "cave_id" TEXT;
ALTER TABLE "photo" ADD COLUMN "cave_id" TEXT;
ALTER TABLE "export_log" ADD COLUMN "cave_id" TEXT;
ALTER TABLE "image_search_cost" ADD COLUMN "cave_id" TEXT;

-- 5. L'existant devient la cave du premier administrateur : le plus ancien
-- compte administrateur actif qui n'est pas le compte de secours, sinon le plus
-- ancien compte de secours actif, sinon personne (base sans compte). Base
-- entièrement vide (installation neuve) : aucune cave n'est créée.
-- Dates en UTC, comme celles que Prisma écrit (CURRENT_TIMESTAMP suivrait le
-- fuseau de la session : une cave créée ensuite paraîtrait plus ancienne).
INSERT INTO "cave" ("id", "name", "owner_id", "created_at")
SELECT
  gen_random_uuid()::TEXT,
  CASE
    WHEN owner_candidate."id" IS NULL THEN 'Ma cave'
    ELSE 'Cave de ' || COALESCE(NULLIF(BTRIM(owner_candidate."display_name"), ''), owner_candidate."email")
  END,
  owner_candidate."id",
  now() AT TIME ZONE 'UTC'
FROM (SELECT 1) AS one
LEFT JOIN LATERAL (
  SELECT u."id", u."display_name", u."email"
  FROM "app_user" u
  WHERE u."status" = 'ACTIVE' AND ((u."is_admin" AND NOT u."is_break_glass") OR u."is_break_glass")
  ORDER BY (u."is_admin" AND NOT u."is_break_glass") DESC, u."created_at" ASC, u."id" ASC
  LIMIT 1
) AS owner_candidate ON TRUE
WHERE EXISTS (SELECT 1 FROM "app_user")
   OR EXISTS (SELECT 1 FROM "wine")
   OR EXISTS (SELECT 1 FROM "photo")
   OR EXISTS (SELECT 1 FROM "export_log")
   OR EXISTS (SELECT 1 FROM "image_search_cost");

-- La table vient d'être créée : elle contient au plus cette cave.
UPDATE "wine" SET "cave_id" = (SELECT "id" FROM "cave");
UPDATE "photo" SET "cave_id" = (SELECT "id" FROM "cave");
UPDATE "export_log" SET "cave_id" = (SELECT "id" FROM "cave");
UPDATE "image_search_cost" SET "cave_id" = (SELECT "id" FROM "cave");

-- Le propriétaire a sa ligne OWNER ; les autres comptes actifs deviennent
-- membres en lecture seule. Les comptes bloqués ne reçoivent aucun accès.
INSERT INTO "cave_member" ("id", "cave_id", "user_id", "role", "created_at")
SELECT gen_random_uuid()::TEXT, c."id", c."owner_id", 'OWNER', now() AT TIME ZONE 'UTC'
FROM "cave" c
WHERE c."owner_id" IS NOT NULL;

INSERT INTO "cave_member" ("id", "cave_id", "user_id", "role", "created_at")
SELECT gen_random_uuid()::TEXT, c."id", u."id", 'VIEWER', now() AT TIME ZONE 'UTC'
FROM "cave" c
JOIN "app_user" u ON u."status" = 'ACTIVE' AND u."id" IS DISTINCT FROM c."owner_id"
ORDER BY u."created_at", u."id";

-- 6. Contraintes : plus aucune ligne sans cave, et unicités par cave.
ALTER TABLE "wine" ALTER COLUMN "cave_id" SET NOT NULL;
ALTER TABLE "photo" ALTER COLUMN "cave_id" SET NOT NULL;
ALTER TABLE "export_log" ALTER COLUMN "cave_id" SET NOT NULL;
ALTER TABLE "image_search_cost" ALTER COLUMN "cave_id" SET NOT NULL;

ALTER TABLE "wine" ADD CONSTRAINT "wine_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photo" ADD CONSTRAINT "photo_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_log" ADD CONSTRAINT "export_log_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_search_cost" ADD CONSTRAINT "image_search_cost_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Le même vin, la même image peuvent exister dans deux caves. Ces index
-- commencent par cave_id : ils servent aussi d'index de filtrage par cave.
DROP INDEX "wine_match_key_key";
CREATE UNIQUE INDEX "wine_cave_id_match_key_key" ON "wine"("cave_id", "match_key");
DROP INDEX "photo_content_hash_key";
CREATE UNIQUE INDEX "photo_cave_id_content_hash_key" ON "photo"("cave_id", "content_hash");
CREATE INDEX "export_log_cave_id_idx" ON "export_log"("cave_id");
CREATE INDEX "image_search_cost_cave_id_created_at_idx" ON "image_search_cost"("cave_id", "created_at");
