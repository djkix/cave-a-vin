-- Descriptif du domaine : un texte par producteur, partagé par tous ses vins et
-- millésimes. Pas de clé étrangère vers wine : le lien passe par la clé
-- normalisée du producteur (normalizeLabel), calculée côté api.
CREATE TYPE "ProducerProfileStatus" AS ENUM ('PENDING', 'DONE', 'UNKNOWN', 'FAILED');

CREATE TABLE producer_profile (
  id TEXT PRIMARY KEY,
  producer_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status "ProducerProfileStatus" NOT NULL DEFAULT 'PENDING',
  description TEXT,
  -- 'GEMINI' (texte généré) ou 'MANUEL' (saisi, jamais remplacé par le worker).
  source TEXT NOT NULL DEFAULT 'GEMINI' CHECK (source IN ('GEMINI', 'MANUEL')),
  model TEXT,
  cost_cents INTEGER,
  error_message TEXT,
  generated_at TIMESTAMP(3),
  updated_by TEXT REFERENCES app_user(id) ON DELETE SET NULL ON UPDATE CASCADE,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
