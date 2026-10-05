-- Lot 4c : accords mets-vins suggérés par Gemini, un jeu par vin, générés en
-- tâche de fond. Seul le résultat est stocké ; il disparaît avec le vin.
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

CREATE TABLE pairing (
  id TEXT PRIMARY KEY,
  wine_id TEXT NOT NULL UNIQUE REFERENCES wine(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status "PairingStatus" NOT NULL DEFAULT 'PENDING',
  dishes TEXT[] NOT NULL DEFAULT '{}',
  model TEXT,
  cost_cents INTEGER,
  error_message TEXT,
  generated_at TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
