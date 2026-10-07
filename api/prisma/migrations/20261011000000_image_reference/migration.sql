-- « Chercher une image » : une image trouvée sur le web (Open Food Facts, site
-- officiel du domaine) peut devenir la vignette d'un vin. Elle est gardée comme
-- une photo à part (purpose = REFERENCE), jamais analysée ni proposée à la
-- confirmation d'entrée. La valeur ajoutée n'est utilisée par aucune requête de
-- cette migration (PostgreSQL l'interdit dans la même transaction).
ALTER TYPE "PhotoPurpose" ADD VALUE 'REFERENCE';

-- Vignette d'avant l'image du web (pour « Revenir à ma photo ») et provenance
-- affichée sous la vignette. Pas de clé étrangère, comme reference_photo_id.
ALTER TABLE wine
  ADD COLUMN reference_photo_previous_id TEXT,
  ADD COLUMN reference_photo_source TEXT,
  ADD COLUMN reference_photo_source_url TEXT;

-- Dépense Gemini des recherches d'image (site officiel), comptée dans le plafond
-- mensuel : une recherche peut coûter sans qu'aucune image ne soit choisie, il
-- lui faut donc sa propre ligne. Pas de clé étrangère : la dépense reste
-- comptée même si le vin est supprimé.
CREATE TABLE image_search_cost (
  id TEXT PRIMARY KEY,
  wine_id TEXT,
  model TEXT,
  cost_cents INTEGER NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX image_search_cost_created_at_idx ON image_search_cost (created_at);
