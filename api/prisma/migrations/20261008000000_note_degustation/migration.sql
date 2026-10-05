-- Lot 4b : une note de dégustation sur 20 par vin, par demi-point.
-- Les trois colonnes sont vides ensemble (vin non noté) ou renseignées ensemble.
ALTER TABLE wine
  ADD COLUMN rating NUMERIC(3,1),
  ADD COLUMN rated_at TIMESTAMP(3),
  ADD COLUMN rated_by TEXT REFERENCES app_user(id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE wine ADD CONSTRAINT wine_rating_valid
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= 20 AND rating * 2 = TRUNC(rating * 2)));
