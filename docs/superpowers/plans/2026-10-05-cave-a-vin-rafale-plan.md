# Entrée en rafale et analyse par lot — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prendre des photos d'entrée à la chaîne sans jamais attendre ; envoi en arrière-plan depuis le téléphone ; analyse Gemini par lots de 8 photos maximum en tâche de fond ; confirmation plus tard dans une liste « À confirmer ».

**Architecture:** Côté serveur, la table `photo` devient la file des entrées (`attempts`, `next_attempt_at`, `dismissed_at`) ; un passage du worker toutes les 15 s réserve jusqu'à 8 photos et fait un seul appel Gemini multi-images, avec repli photo par photo si la réponse se mélange. Les sorties gardent leur travail BullMQ. Côté téléphone, chaque photo est réduite, rangée dans la file IndexedDB existante et envoyée par un envoyeur unique en arrière-plan.

**Tech Stack:** NestJS 10, Prisma 5 (SQL écrit à la main, `migrate deploy`), PostgreSQL 16, BullMQ, `@google/generative-ai`, Jest ; React 18, TanStack Query 5, `idb`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-cave-a-vin-rafale-entree-design.md` (autorité ; ce plan l'argumente).

## Global Constraints

- Texte visible et messages d'erreur **en français**.
- Constantes exactes : `ENTRY_BATCH_SIZE = 8`, `ENTRY_BATCH_MAX_WAIT_MS = 45000`, `ENTRY_BATCH_TICK_MS = 15000`, échéance de réservation **5 min**, file locale **200 photos / 200 Mo**, réduction **1600 px, JPEG 0,8**, rafraîchissement « À confirmer » **10 s**, envoyeur relancé toutes les **15 s** tant que la file n'est pas vide.
- Reprise : même attente que les photos (`extractionBackoffDelay`, `EXTRACTION_ATTEMPTS`) ; plafond via `VisionBudgetService.assertUnderCap()`.
- La sortie par photo (`EXIT`) ne change pas de comportement.
- Une photo n'est jamais perdue ni attribuée au mauvais vin (lot mélangé → relecture unitaire).
- Aucune nouvelle variable d'environnement ni dépendance npm ; `docker-compose.yml` inchangé.
- Commits en français, conventionnels, terminés par exactement une ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests sur `cave_test` uniquement : `DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379` (démarrer si besoin : `pg_isready -h localhost || LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@16 start -l /tmp/pg.log`, `redis-cli ping || redis-server --daemonize yes`, puis `npx prisma migrate deploy`). Jamais la base `cave`.
- Suites à faire passer avant chaque commit : api `npx tsc --noEmit && npx eslint src --quiet && npx jest` (avec les variables ci-dessus) ; web `npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet`.

## Review Focus

1. Deux passages du worker ne doivent jamais réserver la même photo (verrou `FOR UPDATE SKIP LOCKED` + passages non chevauchants).
2. Un tableau Gemini avec un indice dupliqué ou manquant doit déclencher la relecture unitaire, jamais une attribution croisée.
3. Un worker tué en plein lot ne doit pas laisser de photo bloquée en `PROCESSING`.
4. L'envoyeur du téléphone ne doit jamais lancer deux vidanges en parallèle (deux envois de la même photo).
5. Une photo `ENTRY` déjà en file BullMQ avant la mise à jour ne doit pas être analysée deux fois.

---

### Task 1: Schéma et envoi des photos d'entrée sans travail BullMQ

**Files:** migration `api/prisma/migrations/20261009000000_entree_par_lot/migration.sql` ; `api/prisma/schema.prisma` (`Photo.attempts Int @default(0)`, `nextAttemptAt DateTime? @map("next_attempt_at")`, `dismissedAt DateTime? @map("dismissed_at")`, `@@index([purpose, status, nextAttemptAt])`) ; `api/src/photos/photos.service.ts` (`ingest` : pas de `enqueueWithTimeout` pour `ENTRY`) ; `api/src/queue/extraction.processor.ts` (photo `ENTRY` → retour immédiat sans rien modifier, journal « ignorée : analyse par lot ») ; `api/src/queue/orphan-recovery.ts` (ne reprend que `purpose: 'EXIT'`) ; tests associés (`photos.service.spec.ts`, `extraction.processor.spec.ts`, `orphan-recovery.spec.ts`, e2e d'envoi si présent).

Migration :

```sql
-- Entrée en rafale : la table photo sert de file aux analyses d'entrée par lot.
ALTER TABLE photo
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMP(3),
  ADD COLUMN dismissed_at TIMESTAMP(3);
CREATE INDEX photo_entry_batch_idx ON photo (purpose, status, next_attempt_at);
```

Tests à écrire d'abord : `ingest(…, 'ENTRY')` n'appelle pas `queue.add` ; `ingest(…, 'EXIT')` l'appelle comme avant ; le processeur ne touche pas une photo `ENTRY` (aucun `update`, aucun appel vision) ; la reprise des orphelins ne sélectionne que `EXIT`. Adapter les tests existants qui attendaient un travail pour une entrée (sans affaiblir les autres assertions). Commit : `feat(entree): les photos d'entrée attendent l'analyse par lot`.

### Task 2: Lecture multi-images par Gemini

**Files:** `api/src/vision/gemini-vision.provider.ts`, `api/src/vision/vision-provider.interface.ts`, `api/src/vision/extraction-schema.ts` (réutilisé), tests `gemini-vision.provider.spec.ts`.

- Interface : `extractWineLabels(images: Array<{ data: Buffer; mimeType: string }>): Promise<BatchVisionResult>` avec `BatchVisionResult = { items: Array<{ raw: unknown; extraction: WineExtraction } | { error: string }>; model: string; latencyMs: number; costCents: number }` — `items[i]` correspond à `images[i]`.
- `export class VisionBatchMismatchError extends Error` (message commençant par « Sortie du modèle invalide » pour rester définitif côté classification, mais **attrapée par le processeur de lot** qui relit alors photo par photo).
- Consigne : la consigne actuelle d'une étiquette, plus : « Tu reçois N images numérotées de 1 à N. Réponds par un tableau JSON de N objets, dans l'ordre, chacun avec un champ "image" (numéro) et les champs ci-dessus. » ; chaque image précédée d'un texte « Image i : ».
- Analyse : JSON illisible, pas un tableau, longueur ≠ N, indice manquant/dupliqué/hors bornes → `VisionBatchMismatchError`. Objet dont `parseExtraction` échoue → `{ error: 'Lecture de l’étiquette inexploitable' }` pour cet indice seulement.
- Coût : `costCentsOf(usage)` de l'appel entier.
- Tests : réponse correcte de 3 images (ordre rendu par indice même si le tableau arrive désordonné), un objet invalide isolé, longueur fausse, indice dupliqué, JSON illisible, consigne contenant « Image 1 » … « Image N ». Commit : `feat(vision): lecture de plusieurs étiquettes en un seul appel`.

### Task 3: Analyse par lot dans le worker

**Files:** créer `api/src/queue/entry-batch.ts` (constantes + fonctions pures), `api/src/queue/entry-batch.processor.ts` (`EntryBatchProcessor` injectable), `api/src/queue/queue.module.ts` (fournir/exporter), `api/src/worker.ts` (boucle) ; tests `entry-batch.spec.ts`, `entry-batch.processor.spec.ts`, et un test d'intégration base réelle `api/src/queue/entry-batch.integration.spec.ts` (réservation exclusive).

- `entry-batch.ts` : `ENTRY_BATCH_SIZE = 8`, `ENTRY_BATCH_MAX_WAIT_MS = 45_000`, `ENTRY_BATCH_TICK_MS = 15_000`, `RESERVATION_MS = 5 * 60_000` ; `shouldRun(candidates: { createdAt: Date; nextAttemptAt: Date | null }[], now): boolean` (≥ 8, ou la plus ancienne `createdAt` ≤ now − 45 s, ou une `nextAttemptAt` non nulle ≤ now) ; `splitCost(total, n)` = `Math.ceil(total / n)`.
- `EntryBatchProcessor.tick(now = new Date()): Promise<{ processed: number }>` :
  1. **Reprise** : `UPDATE photo SET status='PENDING', next_attempt_at=NULL WHERE purpose='ENTRY' AND status='PROCESSING' AND next_attempt_at <= now`.
  2. Lire les candidates (`ENTRY`, `PENDING`, `dismissed_at IS NULL`, `next_attempt_at IS NULL OR <= now`, triées par `created_at`, 50 max) ; si `!shouldRun` → `{ processed: 0 }`.
  3. **Réserver** dans `prisma.$transaction` : `SELECT id FROM photo WHERE <mêmes conditions> ORDER BY created_at LIMIT 8 FOR UPDATE SKIP LOCKED`, puis `UPDATE … SET status='PROCESSING', next_attempt_at = now + 5 min WHERE id IN (…)`.
  4. `budget.assertUnderCap()` ; lire chaque image (`photos.readNormalized`) ; `vision.extractWineLabels(...)`.
  5. Succès : pour chaque photo, `DONE` + `rawExtraction`, `model`, `latencyMs`, `costCents = splitCost`, `errorMessage = null`, `next_attempt_at = null` ; ou `FAILED` + l'erreur de l'item.
  6. `VisionBatchMismatchError` : relire chaque photo seule avec `vision.extractWineLabel` (succès → DONE avec son coût ; erreur → même traitement que l'étape 7 pour cette photo seule).
  7. Panne passagère (`isTransientVisionFailure`) : chaque photo du lot → `PENDING`, `attempts + 1`, `next_attempt_at = now + extractionBackoffDelay(attempts + 1)`, `errorMessage = deferralReason(e)` ; si `attempts + 1 >= EXTRACTION_ATTEMPTS` → `FAILED` « {deferralReason} — abandon après {EXTRACTION_ATTEMPTS} tentatives ». Erreur définitive → `FAILED` avec le message.
  8. Ne jamais laisser une exception sortir de `tick` sans avoir remis les photos réservées dans un état cohérent ; journaliser.
- Worker : boucle `setInterval(ENTRY_BATCH_TICK_MS)` avec un drapeau « en cours » (pas de chevauchement) ; un premier `tick` au démarrage ; arrêt propre (clearInterval + attendre le tick en cours) dans `stop`.
- Tests (faux Prisma/vision pour l'unitaire) : sélection et `shouldRun` (7 photos récentes → rien ; 8 → lot ; 1 photo de 46 s → lot ; reportée dont l'heure est passée → lot ; écartée/EXIT exclues), lot correct, item invalide isolé, lot mélangé → relecture unitaire, panne → report et attente croissante (`attempts` 0 → 30 s, 2 → 2 min), abandon au-delà, erreur définitive, plafond, coût partagé, reprise des `PROCESSING` échues, non-chevauchement. Intégration (base réelle) : deux `tick` lancés en parallèle sur 8 photos → chaque photo traitée une seule fois. Commit : `feat(entree): analyse des photos d'entrée par lots de huit`.

### Task 4: API « À confirmer » et écarter une photo

**Files:** `api/src/photos/photos.service.ts` (`entryInbox()`, `dismiss(id)`, `listPendingReview` exclut les écartées), `api/src/photos/photos.controller.ts` (`GET entry-inbox` déclaré avant `:id`, `POST :id/dismiss` `@HttpCode(200)`), tests service + e2e.

- `entryInbox()` : trois requêtes (`ENTRY`, `movements: { none: {} }`, `dismissedAt: null`) — `toConfirm` = `DONE` (avec `extraction` parsée comme `pending-review`, `null` si illisible), `inProgress` = `PENDING|PROCESSING`, `failed` = `FAILED` ; tri par `createdAt` ; 200 max chacune.
- `dismiss(id)` : 404 « Photo introuvable » ; 409 « Photo déjà utilisée par une entrée » si un mouvement référence la photo ; sinon `dismissedAt = now`. Réponse `{ ok: true }`.
- Tests : sections et exclusions (sortie, écartée, déjà entrée), dismiss 404/409/ok, e2e `GET entry-inbox` (200, forme), `POST dismiss` (401 sans session). Commit : `feat(entree): liste des vins à confirmer et photos écartées`.

### Task 5: Téléphone — réduction, file 200 photos, envoyeur unique

**Files:** créer `web/src/lib/shrink-photo.ts` (+ test) ; `web/src/lib/offline-queue.ts` (limites 200 / 200 Mo, message de file pleine, mode `'entry' | 'single' | 'campaign'` rétrocompatible) ; créer `web/src/lib/photo-sender.ts` (+ test) ; `web/src/lib/use-offline-queue.ts` (utilise l'envoyeur, intervalle 15 s) ; `web/src/components/OfflineQueueBanner.tsx` (« N photos en cours d'envoi »).

- `shrinkPhoto(file: Blob): Promise<Blob>` : `createImageBitmap` → canvas au plus 1600 px de côté → `canvas.convertToBlob`/`toBlob('image/jpeg', 0.8)` ; si une étape échoue ou l'API manque, renvoyer le fichier d'origine. Ne jamais agrandir.
- `photo-sender.ts` : `sendQueuedPhotos(): Promise<void>` à **vol unique** (si une vidange est en cours, renvoyer la même promesse) qui appelle `flushQueue(uploadPhoto)` puis `notifyQueueChanged()` ; `kickSender()` = `void sendQueuedPhotos()`. `flushQueue` s'arrête à la première erreur réessayable (ne pas tenter les suivantes) — l'adapter si besoin, tests à l'appui.
- Message file pleine : « File d'envoi pleine (200 photos) — attendez que les envois partent ».
- Tests : réduction (mock `createImageBitmap`/canvas : 4000×3000 → 1600×1200 ; repli si erreur), limites, vol unique (deux appels simultanés → un seul `uploadPhoto` par photo), arrêt sur erreur réessayable, retrait sur refus 400. Commit : `feat(entree): envoi des photos en arrière-plan depuis le téléphone`.

### Task 6: Téléphone — rafale, « À confirmer », badge d'accueil

**Files:** `web/src/pages/EntreeCapturePage.tsx` (rafale) ; créer `web/src/pages/AConfirmerPage.tsx` en reprenant `CampagneReviewPage.tsx` (édition des fiches, quantité, *Tout valider* via `createMovementsBulk`) + validation unitaire + *Écarter* + sections « En cours d'analyse » et « Lecture impossible » ; supprimer `CampagneCapturePage.tsx`/`CampagneReviewPage.tsx` et leurs tests (en reportant les cas utiles dans `AConfirmerPage.test.tsx`) ; `web/src/router.tsx` (`/a-confirmer`, redirections `/entree/campagne` → `/entree`, `/entree/campagne/revue` → `/a-confirmer` via `<Navigate replace>`) ; `web/src/pages/HomePage.tsx` (supprimer le bouton « Mode campagne », ajouter le badge « N vins à confirmer » quand N > 0, requête `entry-inbox` rafraîchie toutes les 30 s) ; `web/src/lib/api-client.ts` (`EntryInbox`, `getEntryInbox`, `dismissPhoto`).

- Rafale : bouton « Prendre une photo » (puis « Photo suivante ») ; à la sélection : `shrinkPhoto` → `enqueuePhoto(blob, 'entry')` → `kickSender()` → compteur + 1 → champ prêt (réinitialiser l'input). Aucun `await` d'envoi réseau. Erreur de file pleine affichée. Bandeau de file hors ligne et lien « Voir les vins à confirmer ».
- « À confirmer » : `useQuery(['entry-inbox'], getEntryInbox, { refetchInterval: 10_000 })` ; fiches `toConfirm` comme la revue groupée (quantité lue sinon 1) ; *Valider* une fiche = `createMovementsBulk([une])` ; *Tout valider* ; *Écarter* = `dismissPhoto` ; « En cours d'analyse (environ 1 min) » ou `errorMessage` ; « Lecture impossible » avec *Saisir à la main* (lien `/entree/:photoId`) et *Écarter*. Après validation ou écart, invalider `entry-inbox`, `cave`, `movements`.
- Tests : rafale (trois sélections → trois `enqueuePhoto`, compteur 3, `uploadPhoto` jamais attendu par l'écran), page « À confirmer » (trois sections, valider une, tout valider, écarter, lien saisie manuelle, fiche incomplète non validable), badge d'accueil (affiché si N > 0, absent sinon), redirections. Commit : `feat(entree): rafale de photos et liste des vins à confirmer`.

### Task 7: Documentation et essai

README (fonctionnalités : remplacer « Mode campagne » et « Entrée par photo » par la rafale, l'envoi en arrière-plan, l'analyse par lot de 8, « À confirmer », le badge ; limites : délai 15 s à 1 min, lot mélangé relu photo par photo). Essai navigateur 375 px par le contrôleur. Commit : `docs: entrée en rafale et analyse par lot dans le README`.
