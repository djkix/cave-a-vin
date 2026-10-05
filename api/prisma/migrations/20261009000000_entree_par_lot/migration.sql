-- Entrée en rafale : la table photo sert de file aux analyses d'entrée par lot.
ALTER TABLE photo
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMP(3),
  ADD COLUMN dismissed_at TIMESTAMP(3);
CREATE INDEX photo_entry_batch_idx ON photo (purpose, status, next_attempt_at);
