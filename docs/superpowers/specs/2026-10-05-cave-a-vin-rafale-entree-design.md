# Cave & Terroir — Design : entrée en rafale et analyse par lot

2026-10-05 · Franck Laval

## Contexte

Aujourd'hui, « Rentrer du vin » attend le résultat de l'analyse de chaque photo
avant de laisser confirmer la fiche ; le mode campagne enchaîne les photos mais
attend la fin de chaque envoi, et chaque photo coûte un appel Gemini. Franck veut
« prendre une photo, puis la suivante, sans attendre », avec une analyse en tâche
de fond, **peu d'appels Gemini**, un résultat en **30 s à 1 min** acceptable, et
ne jamais être bloqué pour rentrer de nouvelles bouteilles.

## Décisions prises

| Question | Décision |
| --- | --- |
| Parcours | **Rafale + confirmation plus tard** : « Rentrer du vin » devient la rafale ; les fiches lues arrivent dans une liste **« À confirmer »** (badge sur l'accueil) ; le mode campagne disparaît, fusionné dans ce parcours |
| Économie d'appels | **Analyse par lot** : jusqu'à 8 photos par appel Gemini, la base de données sert de file (approche A) |
| Quantité | Lue sur le carton, sinon 1, **modifiable à la confirmation** |
| Envoi | **En arrière-plan** depuis le téléphone, via la file locale existante, après réduction de la photo |
| Sortie par photo | **Inchangée** (travail BullMQ immédiat, à l'unité) |

## Téléphone

### Rafale (`/entree`)

- Un grand bouton photo et un compteur « N photos prises » (session en cours).
- À chaque prise : la photo est **réduite** sur le téléphone (côté le plus long
  1600 px, JPEG qualité 0,8 ; si la réduction échoue — format non lisible par le
  navigateur — la photo part telle quelle), **rangée dans la file locale**, et
  l'écran est aussitôt prêt pour la suivante. Aucune attente d'envoi ni
  d'analyse.
- Lien « Voir les vins à confirmer » vers la liste.
- `/entree/campagne` et `/entree/campagne/revue` redirigent vers `/entree` et
  `/a-confirmer` ; le bouton « Mode campagne » de l'accueil disparaît.

### Envoi en arrière-plan

- La file locale (IndexedDB) accepte désormais **200 photos et 200 Mo**.
- Un **envoyeur unique** (une seule vidange à la fois dans l'application) envoie
  les photos **une par une**, dans l'ordre ; il est relancé après chaque prise,
  au retour du réseau, au retour au premier plan de l'application et toutes les
  15 s tant que la file n'est pas vide.
- Erreur réessayable (réseau, 5xx, 429) : la photo reste en file, l'envoyeur
  s'arrête et reprendra au prochain déclenchement. Refus définitif (4xx autre
  que 401/403/429) : la photo est retirée de la file (comportement actuel).
- Le bandeau existant de la file hors ligne indique « N photos en cours
  d'envoi ».
- File pleine : « File d'envoi pleine (200 photos) — attendez que les envois
  partent ».

### « À confirmer » (`/a-confirmer`)

Remplace la revue groupée. Trois sections :

1. **À valider** : photos d'entrée lues (`DONE`), sans mouvement et non
   écartées. Fiche pré-remplie (champs modifiables, confiance basse signalée),
   quantité = cartons lus sinon 1, modifiable. Boutons *Valider* par fiche et
   *Tout valider* (fiches complètes), *Écarter* par fiche.
2. **En cours d'analyse** : photos `PENDING`/`PROCESSING` — « Analyse en cours
   (environ 1 min) », ou la raison d'un report (`errorMessage`).
3. **Lecture impossible** : photos `FAILED` — raison, bouton *Saisir à la main*
   (vers la page de confirmation existante `/entree/:photoId`) et *Écarter*.

La liste se rafraîchit toutes les 10 s. L'accueil affiche un badge « N vins à
confirmer » (À valider + Lecture impossible) qui mène à la liste.

## Serveur

### Données

Migration sur `photo` : `attempts INTEGER NOT NULL DEFAULT 0`,
`next_attempt_at TIMESTAMP(3)` (nullable), `dismissed_at TIMESTAMP(3)`
(nullable). Index sur `(purpose, status, next_attempt_at)`.

### Envoi d'une photo d'entrée

`POST /api/photos` (purpose `ENTRY`) enregistre la photo `PENDING` et **ne crée
plus de travail BullMQ**. Les photos de sortie (`EXIT`) gardent leur travail
immédiat. La déduplication par empreinte est inchangée.

### Analyse par lot (worker)

- **Passage toutes les 15 s** (`ENTRY_BATCH_TICK_MS = 15000`), jamais deux
  passages simultanés.
- **Candidates** : photos `ENTRY`, `PENDING`, non écartées, dont
  `next_attempt_at` est vide ou passé.
- **Déclenchement** : au moins `ENTRY_BATCH_SIZE = 8` candidates, ou la plus
  ancienne créée depuis `ENTRY_BATCH_MAX_WAIT_MS = 45000` ou plus (ou dont
  `next_attempt_at` est passé — une photo reportée repart dès son heure).
- **Réservation** : les 8 plus anciennes candidates passent `PROCESSING` dans
  une transaction (`SELECT … FOR UPDATE SKIP LOCKED`), avec `next_attempt_at =
  maintenant + 5 min` (échéance de la réservation).
- **Plafond** : `assertUnderCap()` avant l'appel ; dépassé → report (voir
  pannes).
- **Appel** : un seul `generateContent` avec les images numérotées 1..N et la
  consigne de rendre un tableau JSON de N objets `{ "image": i, …champs de
  l'extraction actuelle… }`, dans l'ordre.
- **Vérification** : exactement N objets, indices 1..N chacun une fois ; sinon
  **lot mélangé** → chaque photo du lot est relue seule (appel unitaire
  existant `extractWineLabel`). Chaque objet passe par le schéma d'extraction
  existant : un objet invalide fait passer **sa** photo en `FAILED` (« Lecture
  de l'étiquette inexploitable »), les autres sont `DONE`.
- **Coût** : coût de l'appel réparti sur les photos du lot,
  `ceil(total / N)` par photo.
- **Pannes passagères** (`isTransientVisionFailure`, plafond compris) : tout le
  lot revient `PENDING`, `attempts + 1`, `next_attempt_at = maintenant +
  extractionBackoffDelay(attempts)` (30 s doublée jusqu'à 15 min), `errorMessage
  = deferralReason(e)`. Après `EXTRACTION_ATTEMPTS` tentatives : `FAILED` avec
  « … — abandon après N tentatives ».
- **Erreur définitive** (clé invalide…) : tout le lot `FAILED` avec le message.
- **Reprise** : à chaque passage (donc aussi au démarrage du worker), une photo
  `ENTRY` encore `PROCESSING` dont l'échéance de réservation (`next_attempt_at`)
  est passée revient `PENDING` avec `next_attempt_at` vide.
- **Anciens travaux** : un travail BullMQ d'extraction d'une photo `ENTRY`
  encore présent dans Redis à la mise à jour est **ignoré** (le lot s'en charge).
  La reprise des orphelins au démarrage ne concerne plus que les photos `EXIT`.
- Les événements temps réel (SSE) et `GET /api/photos/queue-status` continuent
  de refléter les changements d'état.

### API

| Route | Rôle |
| --- | --- |
| `GET /api/photos/entry-inbox` | `{ toConfirm: Photo+extraction[], inProgress: Photo[], failed: Photo[] }` — photos `ENTRY` sans mouvement, non écartées (200 max par section) |
| `POST /api/photos/:id/dismiss` | Écarte une photo d'entrée sans mouvement (`dismissed_at`) ; `404` « Photo introuvable », `409` « Photo déjà utilisée par une entrée » si un mouvement existe |
| `GET /api/photos/pending-review` | Conservé (compatibilité), = section `toConfirm` |

## Erreurs

| Situation | Comportement |
| --- | --- |
| Réseau coupé en cave | Photos en file locale, envoi à la reprise ; la prise continue |
| File locale pleine | Message ; les photos déjà prises restent |
| Gemini indisponible / plafond | Lot reporté, raison affichée dans « En cours d'analyse » |
| Lot mélangé | Relecture photo par photo, aucune attribution croisée |
| Une fiche illisible dans un lot | Seule cette photo en « Lecture impossible » |
| Worker redémarré en plein lot | Photos reprises après 5 min |

## Tests

- **Lot** : sélection (seuil 8, délai 45 s, `next_attempt_at`, écartées
  exclues, sortie exclue), réservation exclusive, appel unique, réponse
  correcte, objet invalide isolé, lot mélangé → relecture unitaire, panne
  passagère → report avec attente croissante, plafond, abandon après N
  tentatives, erreur définitive, partage du coût, reprise des `PROCESSING`
  anciennes, non-chevauchement des passages.
- **Fournisseur Gemini** : consigne multi-images, analyse du tableau, détection
  des incohérences (nombre, indices).
- **Envoi** : photo `ENTRY` sans travail BullMQ, photo `EXIT` avec travail ;
  ancien travail `ENTRY` ignoré par le processeur.
- **API** : `entry-inbox` (trois sections, exclusions), `dismiss` (404, 409).
- **Téléphone** : réduction (et repli), file 200 photos, envoyeur unique
  (une seule vidange, reprise après erreur réessayable, retrait sur refus),
  rafale (compteur, prêt immédiatement, pas d'appel réseau bloquant), liste
  « À confirmer » (trois sections, valider, tout valider, écarter, saisir à la
  main), badge d'accueil, redirections campagne.
- **Navigateur** à 375 px.

## Livraison

- Une migration (`photo.attempts`, `next_attempt_at`, `dismissed_at`).
- Constantes dans le code, aucune nouvelle variable d'environnement ;
  `docker-compose.yml` inchangé.
- README et CHANGELOG en français ; version mineure suivante (après 1.7.0).

## Hors périmètre

- Regroupement des accords mets-vins par lot.
- Mode « batch » asynchrone de Gemini (latence jusqu'à 24 h).
- Entrée automatique sans confirmation.
