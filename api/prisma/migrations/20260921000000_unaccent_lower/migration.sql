CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION unaccent_lower(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(unaccent($1)) $$;
DROP INDEX IF EXISTS idx_appellation_name_trgm;
CREATE INDEX idx_appellation_name_trgm ON appellation USING gin (unaccent_lower(canonical_name) gin_trgm_ops);
