-- CreateEnum
CREATE TYPE "WineColor" AS ENUM ('ROUGE', 'BLANC', 'ROSE', 'PETILLANT');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('IN', 'OUT', 'ADJUST');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "appellation" (
    "id" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "region" TEXT,
    "allowed_colors" "WineColor"[],
    "guard_min_years" INTEGER,
    "guard_max_years" INTEGER,

    CONSTRAINT "appellation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wine" (
    "id" TEXT NOT NULL,
    "match_key" TEXT NOT NULL,
    "producer" TEXT NOT NULL,
    "cuvee" TEXT,
    "appellation_id" TEXT,
    "appellation_raw" TEXT NOT NULL,
    "vintage" INTEGER,
    "color" "WineColor" NOT NULL,
    "format_cl" INTEGER NOT NULL DEFAULT 75,
    "apogee_min" INTEGER,
    "apogee_max" INTEGER,
    "apogee_source" TEXT,
    "idealwine_ref" TEXT,
    "reference_photo_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement" (
    "id" TEXT NOT NULL,
    "wine_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "type" "MovementType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "photo_id" TEXT,
    "price_unit_cents" INTEGER,
    "note" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "reverses_id" TEXT,

    CONSTRAINT "movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo" (
    "id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'image/jpeg',
    "status" "PhotoStatus" NOT NULL DEFAULT 'PENDING',
    "raw_extraction" JSONB,
    "model" TEXT,
    "latency_ms" INTEGER,
    "cost_cents" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "google_sub" TEXT,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "is_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowed_email" (
    "email" TEXT NOT NULL,
    "added_by" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allowed_email_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "export_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filter" JSONB,
    "row_count" INTEGER NOT NULL,

    CONSTRAINT "export_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appellation_canonical_name_key" ON "appellation"("canonical_name");

-- CreateIndex
CREATE UNIQUE INDEX "wine_match_key_key" ON "wine"("match_key");

-- CreateIndex
CREATE UNIQUE INDEX "movement_idempotency_key_key" ON "movement"("idempotency_key");

-- CreateIndex
CREATE INDEX "movement_wine_id_occurred_at_idx" ON "movement"("wine_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "photo_content_hash_key" ON "photo"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_google_sub_key" ON "app_user"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- AddForeignKey
ALTER TABLE "wine" ADD CONSTRAINT "wine_appellation_id_fkey" FOREIGN KEY ("appellation_id") REFERENCES "appellation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement" ADD CONSTRAINT "movement_wine_id_fkey" FOREIGN KEY ("wine_id") REFERENCES "wine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement" ADD CONSTRAINT "movement_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_appellation_name_trgm ON appellation USING gin (canonical_name gin_trgm_ops);

-- Stock never negative (BEFORE INSERT so the failing row is rejected, not corrected)
CREATE OR REPLACE FUNCTION check_stock_non_negative() RETURNS TRIGGER AS $$
DECLARE current_stock INTEGER;
BEGIN
  IF NEW.delta = 0 THEN
    RAISE EXCEPTION 'movement.delta ne peut pas être nul';
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO current_stock FROM movement WHERE wine_id = NEW.wine_id;
  IF current_stock + NEW.delta < 0 THEN
    RAISE EXCEPTION 'il ne reste aucune bouteille de ce vin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_stock_non_negative
BEFORE INSERT ON movement FOR EACH ROW EXECUTE FUNCTION check_stock_non_negative();

-- Current stock as a materialized view (append-only journal => stock is a SUM)
CREATE MATERIALIZED VIEW stock_courant AS
SELECT wine_id, SUM(delta)::INTEGER AS quantity FROM movement GROUP BY wine_id;
CREATE UNIQUE INDEX idx_stock_courant_wine_id ON stock_courant (wine_id);

-- Plain REFRESH (not CONCURRENTLY): CONCURRENTLY cannot run inside a transaction block,
-- and a trigger always runs inside the inserting transaction.
CREATE OR REPLACE FUNCTION refresh_stock_courant() RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW stock_courant;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_stock_courant
AFTER INSERT ON movement FOR EACH STATEMENT EXECUTE FUNCTION refresh_stock_courant();
