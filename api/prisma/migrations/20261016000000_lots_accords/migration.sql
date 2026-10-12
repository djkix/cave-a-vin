-- Accords et descriptifs de domaine par lots : les tables `pairing` et
-- `producer_profile` servent de file au worker, comme `photo` pour les photos
-- d'entrée. Une demande en attente (PENDING) part dans le lot suivant, dix au
-- plus par appel Gemini. Ajout seulement : aucune donnée existante n'est
-- supprimée ; seules changent la date de demande des lignes déjà en attente
-- et les lignes Gemini en échec, remises en attente.
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
-- de leur dernière mise à jour, elles partent dans les premiers lots. Jamais
-- plus d'un jour en arrière : une panne n'abandonne une demande qu'au bout de
-- 7 jours d'attente, une vieille demande ne doit pas y arriver d'un coup.
UPDATE "pairing" SET "requested_at" = GREATEST("updated_at", (now() AT TIME ZONE 'UTC') - interval '1 day')
WHERE "status" = 'PENDING';
UPDATE "producer_profile" SET "requested_at" = GREATEST("updated_at", (now() AT TIME ZONE 'UTC') - interval '1 day')
WHERE "status" = 'PENDING';

-- Accords et descriptifs Gemini en échec avec la version précédente (réponse
-- unique inexploitable, panne trop longue) : relancés une fois, par lots. Un
-- descriptif saisi à la main n'est jamais touché.
UPDATE "pairing"
SET "status" = 'PENDING', "attempts" = 0, "next_attempt_at" = NULL, "error_message" = NULL,
    "requested_at" = (now() AT TIME ZONE 'UTC')
WHERE "status" = 'FAILED';
UPDATE "producer_profile"
SET "status" = 'PENDING', "attempts" = 0, "next_attempt_at" = NULL, "error_message" = NULL,
    "requested_at" = (now() AT TIME ZONE 'UTC')
WHERE "status" = 'FAILED' AND "source" = 'GEMINI';

-- Choix du lot : demandes en attente, les plus anciennes d'abord.
CREATE INDEX "pairing_status_requested_at_idx" ON "pairing"("status", "requested_at");
CREATE INDEX "producer_profile_status_requested_at_idx" ON "producer_profile"("status", "requested_at");
