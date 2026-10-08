-- Zones de la cave : la zone d'un emplacement n'est plus un texte libre mais
-- une zone de la liste de la cave (nom, indication, photo, ordre d'affichage).
-- Les zones déjà saisies deviennent des zones de la liste : rien n'est perdu,
-- chaque bouteille garde le même emplacement (mêmes lignes `location`, mêmes
-- mouvements) et donc le même stock.
--
-- Sauvegarder la base avant d'appliquer cette migration : elle supprime les
-- colonnes location.zone et location.label_key une fois les zones reprises.

-- 1. Zones, propres à chaque cave. Nom unique par cave sans tenir compte de la
-- casse, parmi les zones non archivées : une zone archivée (elle a servi dans
-- l'historique) libère son nom. L'index commence par cave_id et sert aussi de
-- filtre par cave. Date en UTC, comme celles que Prisma écrit.
CREATE TABLE "cave_zone" (
  "id" TEXT NOT NULL,
  "cave_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "indication" TEXT,
  -- Chemin relatif à PHOTO_STORAGE_DIR (`zones/<id>.jpg`), nul sans photo.
  "photo_path" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  CONSTRAINT "cave_zone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cave_zone_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cave_zone_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 40),
  CONSTRAINT "cave_zone_indication_length_check" CHECK ("indication" IS NULL OR char_length("indication") <= 300)
);
CREATE UNIQUE INDEX "cave_zone_cave_id_name_key" ON "cave_zone" ("cave_id", lower("name")) WHERE "archived_at" IS NULL;

-- 2. Zone d'un emplacement (facultative). Une zone encore désignée par un
-- emplacement ne peut pas être supprimée : elle est archivée.
ALTER TABLE "location" ADD COLUMN "zone_id" TEXT;
ALTER TABLE "location" ADD CONSTRAINT "location_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "cave_zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "location_zone_id_idx" ON "location"("zone_id");

-- 3. Reprise : une zone par cave et par nom distinct, comparé sans les espaces
-- autour et sans tenir compte de la casse. Graphie gardée : celle de
-- l'emplacement le plus ancien. Ordre d'affichage : par nom.
INSERT INTO "cave_zone" ("id", "cave_id", "name", "sort_order")
SELECT gen_random_uuid()::TEXT, d."cave_id", d."name",
       (row_number() OVER (PARTITION BY d."cave_id" ORDER BY lower(d."name"), d."name") - 1)::INTEGER
FROM (
  SELECT DISTINCT ON ("cave_id", lower(btrim("zone"))) "cave_id", btrim("zone") AS "name"
  FROM "location"
  WHERE btrim(coalesce("zone", '')) <> ''
  ORDER BY "cave_id", lower(btrim("zone")), "created_at", "id"
) d;

UPDATE "location" l
SET "zone_id" = z."id"
FROM "cave_zone" z
WHERE z."cave_id" = l."cave_id"
  AND btrim(coalesce(l."zone", '')) <> ''
  AND lower(z."name") = lower(btrim(l."zone"));

-- 4. Unicité d'un emplacement : (cave, zone, casier et position en minuscules),
-- par un index sur expressions plutôt qu'une clé calculée en double (JS et SQL).
-- Les anciennes clés portaient la zone en minuscules, qui correspond une à une
-- à la nouvelle zone : deux emplacements existants ne peuvent pas entrer en
-- collision. Le libellé suit désormais le nom de la zone (renommage) : le texte
-- de zone et la clé JSON sont supprimés.
DROP INDEX "location_cave_id_label_key_key";
ALTER TABLE "location" DROP CONSTRAINT "location_not_empty_check";
ALTER TABLE "location" DROP COLUMN "label_key";
ALTER TABLE "location" DROP COLUMN "zone";
ALTER TABLE "location" ADD CONSTRAINT "location_not_empty_check" CHECK ("zone_id" IS NOT NULL OR "casier" IS NOT NULL OR "position" IS NOT NULL);
CREATE UNIQUE INDEX "location_place_key" ON "location" (
  "cave_id", coalesce("zone_id", ''), lower(coalesce("casier", '')), lower(coalesce("position", ''))
);
