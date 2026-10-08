# Emplacements et cote iDealwine — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ranger les bouteilles par emplacement (zone / casier / position, par lot, dérivé des mouvements) et saisir à la main la cote iDealwine d'un vin.

**Architecture:** Table `location` par cave + `movement.location_id` ; le stock par emplacement est une somme de mouvements (aucune quantité stockée) ; déplacement = paire de mouvements `MOVE`. Table `price_quote` en ajout seulement ; cote courante = dernière saisie ; visible du seul propriétaire.

**Spec:** `docs/superpowers/specs/2026-10-07-cave-a-vin-emplacements-cote-design.md` (autorité).

## Global Constraints

- Texte visible et messages d'erreur **en français**, exactement ceux de la spec.
- Toutes les nouvelles routes sous `@UseGuards(AuthenticatedGuard, CaveAccessGuard)` avec `@CaveRole` ; ressource d'une autre cave = 404 ; un membre (`VIEWER`) ne reçoit **aucune** clé de cote (`quote`, `idealwineUrl`, valeurs à la cote) et ne peut rien écrire.
- Les mouvements restent la seule source de vérité du stock ; aucune quantité par emplacement n'est stockée.
- Les nouvelles routes doivent être classées dans la matrice `api/src/caves.isolation.e2e.spec.ts` (sinon le test échoue).
- Aucune nouvelle variable d'environnement ni dépendance. Migration SQL écrite à la main, appliquée par `prisma migrate deploy` ; jamais `migrate dev` ; `ALTER TYPE … ADD VALUE 'MOVE'` non utilisée dans la même migration.
- Tests sur `cave_test` uniquement : `DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379` (infra : `pg_isready -h localhost || LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@16 start -l /tmp/pg.log` ; `redis-cli ping || redis-server --daemonize yes --dir /tmp`). Jamais la base `cave`. Ne pas lancer le worker construit.
- api : `npx tsc --noEmit && npx eslint src --quiet && npx jest` + `npm run build` ; web : `npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet` + `npm run build`.
- Commits en français, conventionnels, chacun terminé par exactement une ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Ne pas pousser.

## Review Focus

1. Stock par emplacement cohérent après entrée, sortie, inventaire, déplacement et **annulation** (une annulation rend la bouteille à son emplacement ; annuler un déplacement annule la paire).
2. `MOVE` ne compte ni comme entrée ni comme sortie (statistiques, rythme de consommation, « les plus bus », journal libellé « Déplacé »).
3. Aucune fuite de cote vers un membre (fiche, statistiques) ; export réservé au propriétaire.
4. Emplacements strictement par cave (unicité, filtre, ids d'une autre cave → 404).
5. La migration sur la vraie base : données existantes intactes, toutes les bouteilles « Sans emplacement ».

---

### Task 1: Schéma et migration

Migration `api/prisma/migrations/20261013000000_emplacements_cote/migration.sql` et `schema.prisma` : valeur `MOVE` de `MovementType` ; table `location` (spec 1, unicité `(cave_id, label_key)`, index `cave_id`) ; `movement.location_id` (FK `location`, `ON DELETE RESTRICT`, index) ; table `price_quote` (spec 2, FK `wine` en cascade, `entered_by` FK `app_user` `ON DELETE SET NULL`, index `(wine_id, quoted_on)`). Vérifier que la vue `stock_courant` reste correcte (somme des `delta`, `MOVE` compris — la paire s'annule). Test d'intégration de la migration sur une base au format précédent (même approche que `api/src/prisma/multi-caves.migration.integration.spec.ts`). Commit `feat(emplacements): schéma des emplacements et des cotes`.

### Task 2: Emplacements côté api

`api/src/locations/` : normalisation et création à la volée (`resolveLocation(caveId, input)`), `GET /api/locations` (VIEWER), stock par emplacement d'un vin (`locationsOf(caveId, wineId)` → `[{ id | null, label, quantity }]`, « Sans emplacement » calculé), dernier emplacement utilisé (dernier `IN` de la cave), pré-sélection de sortie. `MovementsService` : `location` à l'entrée (unitaire, lot, « À confirmer »), `locationId | null` à la sortie et à l'inventaire avec 409 « Pas assez de bouteilles à cet emplacement », annulation qui garde l'emplacement, annulation d'un `MOVE` qui annule la paire. `POST /api/wines/:id/move` (OWNER). Fiche `GET /api/wines/:id` : `locations`, `lastLocation` (pour pré-remplir), `exitDefault`. `GET /api/cave?location=` filtre. Statistiques et journal : `MOVE` exclu des entrées/sorties, libellé au journal. Export : colonne « Emplacements ». Matrice d'étanchéité à jour. Tests unitaires + intégration + e2e. Commit(s) `feat(emplacements): …`.

### Task 3: Cote côté api

`api/src/quotes/` : `POST /api/wines/:id/quotes` (OWNER, validation spec 2), cote courante, lien iDealwine calculé (`idealwineSearchUrl(wine)`), valeur de cession (cote × 0,84 arrondie au centime). Fiche : `quote`, `idealwineUrl` pour OWNER, clés absentes pour VIEWER. Statistiques : `quotedValueCents`, `quotedReferences`, `quotableReferences` ajoutés à `PRICE_KEYS`. Export : colonnes cote / date / valeur à la cote. Matrice d'étanchéité à jour. Tests. Commit `feat(cote): cote iDealwine saisie à la main`.

### Task 4: Écrans des emplacements

Bloc « Emplacement » replié à l'entrée (confirmation unitaire et « À confirmer »), pré-rempli, `<datalist>` des emplacements ; question « D'où sort-elle ? » à la sortie (et à l'inventaire en baisse) avec pré-sélection ; section « Emplacements » de la fiche + « Ranger / déplacer » (propriétaire) ; filtre « Emplacement » de la cave ; journal « Déplacé ». Membre : lecture seule. Tests. Commit `feat(web): emplacements`.

### Task 5: Écrans de la cote

Bloc « Cote iDealwine » de la fiche (propriétaire) : sans / avec cote, avertissements, « Voir sur iDealwine » (nouvel onglet, `rel="noopener noreferrer"`), formulaire ; statistiques « Valeur à la cote ». Membre : aucun bloc. Tests. Commit `feat(web): cote iDealwine saisie à la main`.

### Task 6: Documentation

README (fonctionnalités, API, limites : cote saisie à la main et pourquoi, emplacements), annotation du cahier des charges (relevé automatique abandonné — CGS iDealwine ; emplacements livrés). Essai navigateur par le contrôleur. Commit `docs: emplacements et cote iDealwine`.
