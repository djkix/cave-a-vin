-- Accords et descriptifs de domaine par lots : les tables `pairing` et
-- `producer_profile` servent de file au worker, comme `photo` pour les photos
-- d'entrée. Une demande en attente (PENDING) part dans le lot suivant, dix au
-- plus par appel Gemini. Ajout seulement : aucune donnée existante n'est
-- supprimée ni modifiée, hors la date de demande des lignes déjà en attente.
--
--   requested_at    : quand la demande est passée en attente (ordre du lot,
--                     attente de 2 min au plus) ;
--   attempts        : tentatives consommées (réponse inexploitable, panne) ;
--   next_attempt_at : pas de reprise avant cette date (échec, pause, budget) ;
--   reserved_until  : demande prise par un lot en cours jusqu'à cette date.
--
-- Dates en UTC, comme celles que Prisma écrit (CURRENT_TIMESTAMP suivrait le
-- fuseau de la session).
ALTER TABLE "pairing"
  ADD COLUMN "requested_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "reserved_until" TIMESTAMP(3);

ALTER TABLE "producer_profile"
  ADD COLUMN "requested_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "reserved_until" TIMESTAMP(3);

-- Demandes déjà en attente (travaux BullMQ de la version précédente) : datées
-- de leur dernière mise à jour, elles partent dans le premier lot.
UPDATE "pairing" SET "requested_at" = "updated_at" WHERE "status" = 'PENDING';
UPDATE "producer_profile" SET "requested_at" = "updated_at" WHERE "status" = 'PENDING';

-- Choix du lot : demandes en attente, les plus anciennes d'abord.
CREATE INDEX "pairing_status_requested_at_idx" ON "pairing"("status", "requested_at");
CREATE INDEX "producer_profile_status_requested_at_idx" ON "producer_profile"("status", "requested_at");
