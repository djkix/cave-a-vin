-- Emplacements dans la cave et cote iDealwine saisie à la main. Ajouts
-- seulement : aucune donnée existante n'est modifiée, toutes les bouteilles
-- sont « Sans emplacement » (movement.location_id nul) jusqu'à ce qu'on les range.
--
-- La vue stock_courant somme tous les delta sans filtrer par type : la paire de
-- mouvements MOVE d'un déplacement (−N à A, +N à B) s'annule et le stock total
-- ne change pas. Le contrôle du stock jamais négatif somme lui aussi tous les
-- delta du vin. Rien à adapter.

-- 1. Type de mouvement « déplacement ». La valeur ajoutée n'est utilisée par
-- aucune requête de cette migration : PostgreSQL interdit d'employer une valeur
-- d'enum dans la transaction qui l'a créée.
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'MOVE';

-- 2. Emplacements, propres à chaque cave. label_key = zone, casier et position
-- nettoyés, en minuscules, joints par « | » : saisir deux fois le même
-- emplacement donne la même ligne. L'index unique commence par cave_id et sert
-- aussi de filtre par cave.
CREATE TABLE "location" (
  "id" TEXT NOT NULL,
  "cave_id" TEXT NOT NULL,
  "zone" TEXT,
  "casier" TEXT,
  "position" TEXT,
  "label_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "location_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "location_cave_id_fkey" FOREIGN KEY ("cave_id") REFERENCES "cave"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "location_not_empty_check" CHECK ("zone" IS NOT NULL OR "casier" IS NOT NULL OR "position" IS NOT NULL)
);
CREATE UNIQUE INDEX "location_cave_id_label_key_key" ON "location"("cave_id", "label_key");

-- 3. Emplacement d'un mouvement (facultatif). Un emplacement qui a servi ne
-- peut pas être supprimé : le journal est la seule source de vérité du stock.
ALTER TABLE "movement" ADD COLUMN "location_id" TEXT;
ALTER TABLE "movement" ADD CONSTRAINT "movement_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "movement_location_id_idx" ON "movement"("location_id");

-- 4. Cotes iDealwine, en ajout seulement (historique). La cote courante d'un
-- vin est la dernière par quoted_on, puis created_at.
CREATE TABLE "price_quote" (
  "id" TEXT NOT NULL,
  "wine_id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'IDEALWINE',
  "cote_cents" INTEGER NOT NULL,
  "n_transactions" INTEGER,
  "quoted_on" DATE NOT NULL,
  "source_url" TEXT,
  -- Compte qui a saisi la cote ; nul s'il a été supprimé.
  "entered_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "price_quote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_quote_wine_id_fkey" FOREIGN KEY ("wine_id") REFERENCES "wine"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "price_quote_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "price_quote_cote_cents_check" CHECK ("cote_cents" > 0),
  CONSTRAINT "price_quote_n_transactions_check" CHECK ("n_transactions" IS NULL OR "n_transactions" >= 0)
);
CREATE INDEX "price_quote_wine_id_quoted_on_idx" ON "price_quote"("wine_id", "quoted_on");
