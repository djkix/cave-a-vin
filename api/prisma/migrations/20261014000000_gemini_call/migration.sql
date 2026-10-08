-- Journal des appels Gemini : une ligne par requête réellement envoyée à
-- Google, réussie, refusée (429 quota épuisé, 503 modèle saturé : comptées par
-- Google dans ses statistiques, non facturées) ou en erreur. Table d'administration,
-- commune à toutes les caves : le fournisseur Gemini ne connaît pas la cave.
-- Ajout seulement : aucune donnée existante n'est modifiée.
--
-- Date en UTC, comme celles que Prisma écrit (CURRENT_TIMESTAMP suivrait le
-- fuseau de la session).
CREATE TABLE "gemini_call" (
  "id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "usage" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "http_status" INTEGER,
  "reason" TEXT,
  "cost_cents" INTEGER NOT NULL DEFAULT 0,
  "duration_ms" INTEGER NOT NULL,
  CONSTRAINT "gemini_call_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gemini_call_usage_check" CHECK ("usage" IN ('LECTURE_ENTREE', 'LECTURE_SORTIE', 'ACCORDS', 'DESCRIPTIF', 'RECHERCHE_IMAGE')),
  CONSTRAINT "gemini_call_outcome_check" CHECK ("outcome" IN ('OK', 'REFUSE', 'ERREUR')),
  CONSTRAINT "gemini_call_reason_length_check" CHECK ("reason" IS NULL OR char_length("reason") <= 300)
);
CREATE INDEX "gemini_call_created_at_idx" ON "gemini_call"("created_at");
