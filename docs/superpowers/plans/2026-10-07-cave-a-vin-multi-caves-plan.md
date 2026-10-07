# Une cave par compte — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Chaque compte validé a sa cave ; inscriptions validées par l'administrateur ; membres invités en lecture seule ; sélecteur de cave ; étanchéité complète entre caves.

**Architecture:** Tables `cave` et `cave_member`, colonne `cave_id` sur `wine`, `photo`, `export_log`, `image_search_cost` ; garde `CaveAccessGuard` + décorateur `@CaveRole` qui injecte `{ caveId, role }` ; tous les services filtrent par `caveId` ; la session mémorise la cave courante.

**Spec:** `docs/superpowers/specs/2026-10-07-cave-a-vin-multi-caves-design.md` (autorité).

## Global Constraints

- Texte visible et messages d'erreur **en français**, exactement ceux de la spec (section 7).
- Rôles `OWNER` / `VIEWER` ; statut de compte `PENDING` / `ACTIVE` / `BLOCKED`.
- Un membre (`VIEWER`) ne reçoit **jamais** de prix d'achat (champs absents, pas seulement masqués) et ne peut **rien** écrire (403 « Lecture seule »).
- Ressource d'une autre cave = inexistante (404) ; cave non accessible = 404 « Cave introuvable ».
- Descriptifs de domaine, règles d'apogée, référentiel : communs ; écriture réservée aux administrateurs.
- Budget : plafond global inchangé + part par cave (`app_setting.cave_budget_share`, 0,2 par défaut) sauf pour la cave du premier administrateur.
- Aucune nouvelle variable d'environnement ni dépendance.
- Migrations SQL écrites à la main, appliquées par `prisma migrate deploy` ; jamais `migrate dev`.
- Tests sur `cave_test` uniquement : `DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379` (infra : `pg_isready -h localhost || LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@16 start -l /tmp/pg.log` ; `redis-cli ping || redis-server --daemonize yes`). Jamais la base `cave`. Ne pas lancer le worker construit.
- api : `npx tsc --noEmit && npx eslint src --quiet && npx jest` + `npm run build` ; web : `npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet`.
- Commits en français, conventionnels, chacun terminé par exactement une ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Le commit de la tâche 1 porte le pied `BREAKING CHANGE: chaque compte a désormais sa propre cave ; sauvegarder la base avant la mise à jour.` (version 2.0.0).

## Review Focus

1. Une route de cave oubliée par le garde ou un service qui ne filtre pas par `caveId` (fuite entre caves) — matrice e2e de la tâche 7.
2. Le rapprochement des vins (`matchOrCreate`) et la déduplication des photos doivent rester par cave (un même vin dans deux caves = deux fiches).
3. Les prix d'achat ne doivent apparaître dans aucune réponse lue par un membre (liste, fiche, stats, mouvements récents, mouvements de la fiche).
4. La migration doit fonctionner sur la vraie base de Franck (données existantes, compte de secours, plusieurs comptes) et sur une base vide.
5. Le worker (lots, accords, descriptifs, reprises) ne doit pas casser : un lot ne mélange pas deux caves.

---

### Task 1: Schéma et migration

Créer la migration `api/prisma/migrations/20261012000000_multi_caves/migration.sql` et mettre à jour `schema.prisma` selon la spec (sections 2 et 4) : enum `CaveRole`, valeur `PENDING` de `AccountStatus`, tables `cave`, `cave_member` (contraintes d'unicité, un seul OWNER par cave via index partiel), `app_setting`, colonnes `cave_id` + index, nouvelles unicités par cave, migration de l'existant (cave du premier administrateur non-secours, sinon secours, sinon sans propriétaire ; autres comptes ACTIVE → VIEWER). Attention : `ALTER TYPE … ADD VALUE 'PENDING'` ne doit pas être utilisée dans la même transaction ; ne pas l'utiliser dans la migration. Prisma : relations `Cave.owner`, `Cave.members`, `Wine.cave`, `Photo.cave`, etc. Mettre à jour **toutes** les créations existantes dans le code et les tests (wine/photo/export_log/image_search_cost exigent désormais `caveId`) avec une cave de test — ajouter un utilitaire de test `api/src/test-utils/cave.ts` (`createTestCave(prisma, { owner? })`). Test d'intégration `api/src/prisma/multi-caves.migration.integration.spec.ts` : base au format précédent (appliquer les migrations jusqu'à la précédente dans un schéma PostgreSQL dédié, insérer des données, appliquer la nouvelle, vérifier) ou, si trop lourd, script SQL équivalent exécuté dans une transaction annulée ; documenter le choix. Commit : `feat(caves)!: une cave par compte, schéma et migration` avec le pied BREAKING CHANGE.

### Task 2: Comptes, inscriptions, cave courante

`auth.service` : PENDING / invitations / ADMIN_EMAILS (spec 1) ; garde global qui refuse tout sauf `/auth/me`, `/auth/logout`, `/health` pour un compte PENDING (403 « Inscription en attente de validation ») ; `GET /api/auth/me` → `{ …, status, caves: [{ id, name, role }], currentCaveId }` ; `PUT /api/auth/current-cave`. Administration : `GET /api/admin/registrations`, `POST /api/admin/registrations/:id/validate` (→ ACTIVE + cave + OWNER), `POST …/refuse` (→ BLOCKED), `POST /api/admin/users/:id/cave` (créer la cave d'un compte ACTIVE sans cave). Le premier administrateur qui se connecte reçoit une cave orpheline de la migration s'il n'en a pas. Tests unitaires + e2e.

### Task 3: Garde d'accès et cave / vins / mouvements / statistiques / export

`api/src/caves/` : `CaveAccessGuard`, décorateur `@CaveRole`, décorateur de paramètre `@CurrentCave()` → `{ caveId, role }`. Appliquer à `cave.controller`, `movements.controller`, `stats.controller`, `export.controller` (OWNER), journal (`movements/recent` OWNER). Services filtrés par `caveId` : `CaveService` (allWithStock, list, detail, exitCandidates, setManualApogee/rating…), `MovementsService` (createIn via `matchOrCreate(caveId, …)`, createOut, adjustTo, cancel, recent), `WineMatchingService` (par cave), `StatsService` (+ suppression des champs prix pour VIEWER), `ExportService`. Prix absents pour VIEWER dans liste/fiche/mouvements de la fiche. Tests unitaires et e2e ciblés.

### Task 4: Photos, « À confirmer », événements, recherche d'image, accords, descriptifs, qualité de lecture

Garde + filtrage : `photos.controller` (envoi OWNER avec `caveId` posé sur la photo ; image : photo d'une cave accessible ; entry-inbox / pending-review / dismiss / queue-status : OWNER, cave courante), `photo-events.controller` (photo de la cave), `image-search.controller` (OWNER, vin de la cave ; candidate liée au vin donc à la cave), `pairing.controller` (OWNER, vin de la cave), `producers.controller` (écriture administrateur seulement ; lecture via la fiche), `reading-quality` (admin, toutes caves). Dédup des photos par (cave, empreinte). Tests unitaires et e2e ciblés.

### Task 5: Membres, budget par cave, worker

API membres (spec 2) dans `api/src/caves/`. Budget : `app_setting`, `GET/PUT /api/admin/budget { caveShare }` (0 à 1), `VisionBudgetService.assertCaveUnderShare(caveId)` utilisé par le lot d'entrée, la sortie, la recherche d'image (la cave du premier administrateur est exemptée) avec report « Part mensuelle de cette cave atteinte — reprise le mois prochain ». `spentThisMonthCents(caveId?)`. Worker : `EntryBatchProcessor` réserve les photos d'**une seule** cave par lot (la cave de la plus ancienne candidate prête). Tests (dont intégration du lot mono-cave).

### Task 6: Écrans

Écran d'attente (PENDING) ; `RequireAuth` gère `status` ; sélecteur de cave dans `TopBar` (+ invalidation de toutes les requêtes au changement) ; mode lecture seule (onglets, badge, boutons, stats sans prix, export absent) piloté par le rôle courant ; écran **Membres** (`/membres`, lien depuis l'accueil pour OWNER) ; Administration : **Inscriptions**, *Créer sa cave*, **Budget**. Tests.

### Task 7: Étanchéité, documentation

`api/src/caves.isolation.e2e.spec.ts` : matrice route par route (spec 8). README (fonctionnalités, administration, limites, mise à jour avec sauvegarde), annotation du cahier des charges. Essai navigateur par le contrôleur.
