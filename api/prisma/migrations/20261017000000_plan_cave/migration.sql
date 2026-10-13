-- Plan de la cave : une image par cave (photo de la pièce ou d'un schéma dessiné
-- à la main), sur laquelle chaque zone peut porter un repère. Ajout seulement :
-- aucune donnée existante n'est modifiée ni supprimée.

-- 1. Plan, au plus un par cave : des colonnes de `cave` plutôt qu'une table.
--   plan_path       : chemin relatif à PHOTO_STORAGE_DIR (`plans/<id>.jpg`), nul sans plan ;
--   plan_width/height : taille en pixels après normalisation (mise en page des
--                     repères avant le chargement de l'image) ;
--   plan_updated_at : date du dernier envoi (relecture de l'image remplacée).
ALTER TABLE "cave"
  ADD COLUMN "plan_path" TEXT,
  ADD COLUMN "plan_width" INTEGER,
  ADD COLUMN "plan_height" INTEGER,
  ADD COLUMN "plan_updated_at" TIMESTAMP(3);

-- 2. Repère d'une zone sur le plan : fractions de la largeur et de la hauteur
-- de l'image, entre 0 et 1, ou les deux nuls (pas de repère). Gardé quand le
-- plan est retiré ou la zone archivée (une zone archivée n'apparaît jamais sur
-- le plan). NaN et l'infini sont hors de [0, 1] pour PostgreSQL. Les IS NOT
-- NULL comptent : une seule coordonnée nulle rendrait la condition inconnue
-- (NULL), qu'un CHECK accepte.
ALTER TABLE "cave_zone"
  ADD COLUMN "plan_x" DOUBLE PRECISION,
  ADD COLUMN "plan_y" DOUBLE PRECISION,
  ADD CONSTRAINT "cave_zone_plan_position_check" CHECK (
    ("plan_x" IS NULL AND "plan_y" IS NULL)
    OR ("plan_x" IS NOT NULL AND "plan_y" IS NOT NULL AND "plan_x" BETWEEN 0 AND 1 AND "plan_y" BETWEEN 0 AND 1)
  );
