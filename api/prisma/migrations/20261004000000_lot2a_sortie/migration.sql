-- Lot 2a — la cave et la sortie.

-- 1. Destination des photos. Une photo de sortie ne doit ni apparaître dans la
-- revue groupée (elle serait prise pour un vin à rentrer), ni compter dans le
-- bandeau d'attente, ni être reprise au démarrage du worker.
CREATE TYPE "PhotoPurpose" AS ENUM ('ENTRY', 'EXIT');
ALTER TABLE "photo" ADD COLUMN "purpose" "PhotoPurpose" NOT NULL DEFAULT 'ENTRY';

-- 2. Stock jamais négatif, y compris sous concurrence. La version précédente
-- lisait SUM(delta) sans verrou : deux sorties simultanées de la dernière
-- bouteille lisaient toutes deux « 1 » et passaient toutes deux. Le verrou sur
-- la ligne `wine` sérialise les mouvements d'un même vin ; en READ COMMITTED,
-- la lecture qui suit le verrou voit le mouvement validé entre-temps.
CREATE OR REPLACE FUNCTION check_stock_non_negative() RETURNS TRIGGER AS $$
DECLARE current_stock INTEGER;
BEGIN
  IF NEW.delta = 0 THEN
    RAISE EXCEPTION 'movement.delta ne peut pas être nul';
  END IF;
  PERFORM 1 FROM wine WHERE id = NEW.wine_id FOR UPDATE;
  SELECT COALESCE(SUM(delta), 0) INTO current_stock FROM movement WHERE wine_id = NEW.wine_id;
  IF current_stock + NEW.delta < 0 THEN
    RAISE EXCEPTION 'il ne reste aucune bouteille de ce vin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Une photo ne sert qu'à une seule sortie, même avec deux clés
-- d'idempotence différentes (double tap, deux onglets) : garde-fou contre le
-- faux débit.
CREATE UNIQUE INDEX idx_movement_photo_out ON movement (photo_id) WHERE photo_id IS NOT NULL AND type = 'OUT';

-- 4. Photo de référence de chaque vin : celle de sa première entrée. La
-- colonne existait mais n'était jamais renseignée.
UPDATE wine w
SET reference_photo_id = (
  SELECT m.photo_id FROM movement m
  WHERE m.wine_id = w.id AND m.type = 'IN' AND m.photo_id IS NOT NULL
  ORDER BY m.occurred_at ASC
  LIMIT 1
)
WHERE w.reference_photo_id IS NULL;
