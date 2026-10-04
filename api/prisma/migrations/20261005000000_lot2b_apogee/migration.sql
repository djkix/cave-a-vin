-- Lot 2b — l'apogée. Règles d'estimation modifiables par les administrateurs.

CREATE TYPE "VintageQualityLevel" AS ENUM ('GRAND', 'MOYEN', 'FAIBLE');

-- Qualité d'un millésime par région ; une région/année absente est « non qualifiée ».
CREATE TABLE "vintage_quality" (
  "region" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "quality" "VintageQualityLevel" NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vintage_quality_pkey" PRIMARY KEY ("region", "year")
);

-- Ajustements de garde. Hors de la table « appellation », que le
-- rechargement du référentiel réécrit à chaque démarrage de l'api.
CREATE TABLE "guard_override" (
  "id" TEXT NOT NULL,
  "appellation_id" TEXT NOT NULL,
  "color" "WineColor",
  "guard_min_years" INTEGER NOT NULL,
  "guard_max_years" INTEGER NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guard_override_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guard_override_appellation_id_fkey" FOREIGN KEY ("appellation_id") REFERENCES "appellation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "guard_override_range_check" CHECK ("guard_min_years" >= 0 AND "guard_max_years" <= 100 AND "guard_min_years" <= "guard_max_years")
);

-- Un seul ajustement « toutes couleurs » par appellation, un seul par
-- (appellation, couleur). Une contrainte unique ordinaire laisserait passer
-- plusieurs lignes à couleur NULL.
CREATE UNIQUE INDEX idx_guard_override_all_colors ON "guard_override" ("appellation_id") WHERE "color" IS NULL;
CREATE UNIQUE INDEX idx_guard_override_color ON "guard_override" ("appellation_id", "color") WHERE "color" IS NOT NULL;
