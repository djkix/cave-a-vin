-- Inscription libre : n'importe quel compte Google obtient un accès immédiat ;
-- le propriétaire bloque ensuite les comptes indésirables depuis /admin. Les
-- comptes existants deviennent ACTIVE et non administrateurs.
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'BLOCKED');

ALTER TABLE "app_user"
  ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_login_at" TIMESTAMP(3);
