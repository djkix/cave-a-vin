# Cave & Terroir — Design Lot 2a : la cave et la sortie

2026-10-04 · Franck Laval

## Contexte

Cahier des charges source : [`cahier-des-charges.md`](../../../cahier-des-charges.md),
sections « Sortie de stock », « Modes de rattrapage » et « Matching et
dédoublonnage ». Ce document ne le répète pas ; il fixe le **périmètre du lot
2a** et les **décisions prises** lors de la conception.

Le lot 2 du cahier des charges est découpé en trois sous-projets livrés l'un
après l'autre, chacun avec sa spécification, son plan et sa version :

| Sous-projet | Contenu | État |
| --- | --- | --- |
| **2a** | Liste de la cave, fiche vin, sortie par la liste, sortie par photo, inventaire physique | **ce document** |
| 2b | Estimation de l'apogée par règles, affichage et correction | à concevoir |
| 2c | Cote iDealwine à la demande, précédée d'une étude de faisabilité (CGU, couverture, accès authentifié) | à concevoir |

## Intention

L'application sait rentrer une bouteille mais pas la sortir : le stock ne fait
que croître et devient faux dès la première bouteille bue. Le lot 2a boucle le
cycle du stock.

**Critère de réussite** (cahier des charges, lot 2) : une bouteille est sortie
en moins de 20 secondes, **sans faux débit**. Aucune sortie n'est écrite sans
une confirmation explicite de l'utilisateur.

## Décisions prises

| Question | Décision | Conséquence |
| --- | --- | --- |
| Réseau dans la cave au moment de sortir ? | **Toujours disponible** | Tout se fait en ligne avec confirmation immédiate : pas de copie locale de la cave, pas de file de sorties hors ligne |
| Inventaire physique dans 2a ? | **Oui** | « Corriger le stock » sur la fiche vin, écrit un mouvement `ADJUST` daté |
| Reconnaissance à la sortie | **Approche A** : lecture de l'étiquette par Gemini, rapprochement textuel sur les seuls vins en stock, choix final par l'utilisateur sur vignettes | Pas de modèle d'empreintes d'images ni d'arbitrage par un second appel au modèle ; la « similarité visuelle » du cahier des charges est faite par l'œil de l'utilisateur sur les photos d'entrée |
| Comptes multiples | Inchangé : une seule cave, partagée par tous les comptes actifs (inscription libre, blocage a posteriori) | Une sortie faite depuis un autre téléphone est visible immédiatement ; les conflits de stock sont gérés côté serveur |

## Parcours et écrans

Le doré chêne reste l'action d'entrée (*Rentrer*), la ferronnerie noire
l'action de sortie et de validation (*Sortir*), sans exception.

### Onglet Cave — `/cave`

L'onglet *Cave* de la barre de navigation, grisé jusqu'ici, devient actif.

- Liste des vins **en stock** : vignette (photo de référence), producteur,
  cuvée, appellation, millésime, couleur, quantité.
- Recherche texte sur producteur, cuvée et appellation, insensible aux accents
  et à la casse.
- Filtre par couleur.
- Option « Afficher les vins épuisés » (désactivée par défaut) : seul moyen de
  retrouver une référence à zéro pour corriger son stock.
- Paramètre d'URL `?q=` qui pré-remplit la recherche (utilisé par la sortie par
  photo).
- Un tap ouvre la fiche vin.

### Fiche vin — `/cave/:wineId`

- Photo de référence en grand, informations du vin, stock actuel.
- Les 10 derniers mouvements de cette référence (date, type, quantité, note).
- **Sortir** : sélecteur de quantité (1 par défaut, borné au stock), puis
  confirmation. C'est la *sortie par la liste*.
- **Corriger le stock** : saisie du nombre réellement compté ; l'écran annonce
  l'écart avant validation (« −2 bouteilles », « stock déjà juste ») ; la
  validation écrit un mouvement `ADJUST`.
- Après une sortie : « Sorti — il en reste N » et un lien *Annuler* (annulation
  existante du journal).

### Sortie par photo — `/sortie` puis `/sortie/:photoId`

Le bouton *Sortir une bouteille* de l'accueil et l'onglet *Sortie* deviennent
actifs.

1. L'appareil photo s'ouvre ; la photo est envoyée avec `purpose = EXIT`.
2. Écran d'attente (photo + progression), comme à l'entrée.
3. Selon la réponse de la reconnaissance :
   - **unique** → fiche de confirmation : vignette de référence, informations du
     vin, stock actuel, quantité 1, bouton *Sortir* ;
   - **plusieurs** → 1 à 4 vignettes, chacune avec la photo d'entrée, le
     producteur, la cuvée et le **millésime en grand** ; un tap choisit, puis
     fiche de confirmation. Un candidat unique mais peu sûr est montré ainsi,
     en vignette, plutôt que confirmé d'office : l'utilisateur le reconnaît
     d'abord, ce qui évite le faux débit ;
   - **aucun** → « Ce vin n'est pas dans la cave » avec *Chercher dans la cave*
     (liste avec `?q=` pré-rempli par ce que le modèle a lu) et *Rentrer ce
     vin* (flux d'entrée existant).
4. Après la sortie : « Sorti — il en reste N » et *Annuler*.

**Le service de vision ne répond pas.** Une photo de sortie n'est pas reportée
comme une photo d'entrée : l'utilisateur est devant la bouteille, la sortie se
fait tout de suite par la liste, et une analyse qui aboutirait une heure plus
tard ne servirait à rien. L'écran d'attente propose donc *Chercher dans la cave*
au bout de `EXIT_FALLBACK_MS` = 12 s sans résultat, ou immédiatement si
l'analyse échoue. La photo est abandonnée ; rien n'est sorti sans
confirmation. Cette exception au principe « une photo n'est jamais perdue »
vaut uniquement pour les photos de sortie, qui n'ont plus de valeur une fois la
sortie faite autrement.

## Données

### `photo.purpose`

Nouvelle énumération `PhotoPurpose { ENTRY, EXIT }`, colonne `purpose`
(défaut `ENTRY`, donc toutes les photos existantes restent des entrées).

Les photos de sortie sont exclues :

- de la revue groupée (`PhotosService.listPendingReview`) — sinon une photo de
  sortie analysée apparaîtrait comme un vin à rentrer ;
- du compteur d'attente (`PhotosService.queueStatus`) ;
- de la reprise au démarrage (`requeueOrphanPhotos`) : une photo de sortie
  encore `PENDING` ou `PROCESSING` au démarrage du worker passe en `FAILED`
  avec le message « Photo de sortie abandonnée au redémarrage », sans être
  remise en file.

Politique de file pour une photo de sortie : `EXIT_ATTEMPTS` = 2 tentatives,
délai fixe de 3 s, aucun report. À la dernière tentative la photo passe en
`FAILED`, que l'erreur soit passagère ou définitive.

Déduplication par empreinte de contenu : inchangée. Une photo de sortie dont
les octets sont identiques à une photo existante renvoie la photo existante ;
la reconnaissance fonctionne sur toute photo analysée, quelle que soit son
destination.

### `wine.reference_photo_id`

La colonne existe mais n'est jamais renseignée. Elle désigne la photo de la
**première entrée** du vin et sert de vignette partout.

- Migration de rattrapage : pour chaque vin sans photo de référence, la photo
  du plus ancien mouvement `IN` portant une photo.
- `MovementsService.createIn` la renseigne quand elle est vide.
- Un vin sans photo (saisi à la main) affiche un pictogramme de bouteille.

### Mouvement `OUT`

- `delta = −quantité`, `type = OUT`, `photo_id` éventuel, clé d'idempotence
  obligatoire.
- La contrainte existante « stock jamais négatif » (déclencheur en base) reste
  l'arbitre final ; son erreur est traduite en `409` lisible.
- Nouvel index unique partiel `idx_movement_photo_out` sur `movement(photo_id)
  WHERE type = 'OUT'` : une photo ne peut servir qu'à une seule sortie, même avec
  deux clés d'idempotence différentes (double tap, deux onglets). Comme les
  index partiels existants, il est écrit à la main dans la migration
  (`prisma migrate dev --create-only`).

### Inventaire (`ADJUST`)

Dans une transaction : verrou `SELECT … FOR UPDATE` sur la ligne `wine`,
lecture du stock par `SUM(delta)` sur `movement` (et non dans la vue
matérialisée), calcul de l'écart, écriture d'un `ADJUST` avec la note
« Inventaire : N comptées ». Un écart nul n'écrit rien.

## API

Toutes les routes exigent une session active (garde existante).

| Méthode et route | Entrée | Réponse |
| --- | --- | --- |
| `GET /cave` | `q?`, `color?`, `includeEmpty?` | `[{ wine, quantity, referencePhotoId }]`, trié par producteur puis millésime |
| `GET /wines/:id` | — | `{ wine, quantity, referencePhotoId, movements: [10 derniers] }` ; `404` si inconnu |
| `POST /photos` | fichier + champ `purpose` (`ENTRY` par défaut) | inchangée |
| `GET /photos/:id/exit-candidates` | — | `{ status, outcome?, read?, candidates? }` (voir ci-dessous) |
| `POST /movements/out` | `{ idempotencyKey, wineId, quantity, photoId? }` | `MovementResult` existant ; `409` « Il n'en reste que N » si stock insuffisant ; une photo déjà utilisée renvoie la première sortie (`created: false`) |
| `POST /wines/:id/inventory` | `{ idempotencyKey, counted }` | `{ movement \| null, stock, delta, created }` ; `400` si `counted` n'est pas un entier ≥ 0 |

### `GET /photos/:id/exit-candidates`

- Photo pas encore analysée → `{ status: 'PENDING' | 'PROCESSING' }`.
- Analyse en échec → `{ status: 'FAILED', errorMessage }`.
- Analyse terminée → `{ status: 'DONE', outcome: 'UNIQUE' | 'SEVERAL' | 'NONE',
  read: { producer, cuvee, appellation, vintage }, candidates: [{ wine,
  quantity, referencePhotoId, score }] }`, `candidates` vide pour `NONE`.

`read` est ce que le modèle a lu, pour pré-remplir la recherche du cas `NONE`.

## Reconnaissance à la sortie

Fonction pure `rankExitCandidates(read, inStock)` dans `api/src/wines/`,
testable sans base. Les vins en stock sont au plus quelques centaines : le
calcul se fait en mémoire.

1. **Normalisation** : `normalizeName` existant (minuscules, accents retirés,
   ponctuation supprimée, mots vides « domaine », « château », « cuvée »…).
2. **Score textuel** = `W_NAME` × similarité trigramme(producteur + cuvée lus,
   producteur + cuvée du vin) + `W_APPELLATION` × similarité trigramme(appellation
   lue, appellation du vin). Similarité trigramme calculée par une fonction pure
   reprenant la définition de `pg_trgm` (trigrammes de mots complétés par des
   espaces, rapport intersection / union).
3. **Millésime** : égal → `+ VINTAGE_MATCH_BONUS` ; connus des deux côtés et
   différents → score multiplié par `VINTAGE_MISMATCH_FACTOR` ; illisible d'un
   côté → neutre.
4. **Décision** :
   - candidats retenus : score ≥ `MIN_CANDIDATE_SCORE`, au plus
     `MAX_CANDIDATES`, triés par score décroissant ;
   - `UNIQUE` si le premier a un score ≥ `UNIQUE_MIN_SCORE` **et** un écart
     ≥ `UNIQUE_MIN_GAP` avec le second (ou s'il est seul) ;
   - `SEVERAL` s'il reste au moins un candidat sans remplir la condition
     `UNIQUE` ;
   - `NONE` sinon.

Valeurs initiales, constantes nommées et documentées, à caler par les tests :

| Constante | Valeur initiale |
| --- | --- |
| `W_NAME` / `W_APPELLATION` | 0,6 / 0,4 |
| `VINTAGE_MATCH_BONUS` | 0,25 |
| `VINTAGE_MISMATCH_FACTOR` | 0,3 |
| `MIN_CANDIDATE_SCORE` | 0,35 |
| `UNIQUE_MIN_SCORE` | 0,6 |
| `UNIQUE_MIN_GAP` | 0,15 |
| `MAX_CANDIDATES` | 4 |

Cas de test de référence (au minimum) : deux millésimes du même vin, millésime
lu → `UNIQUE` sur le bon ; deux millésimes, millésime illisible → `SEVERAL`
avec les deux ; producteur lu avec et sans « Château » ni accents → même
classement ; vin absent de la cave → `NONE` ; deux cuvées du même domaine →
`SEVERAL` ou `UNIQUE` selon la cuvée lue ; un vin à zéro bouteille n'est jamais
candidat.

## Erreurs

| Situation | Comportement |
| --- | --- |
| Stock modifié entre l'affichage et la confirmation | `409` avec le stock actuel ; la fiche se rafraîchit ; rien n'est écrit |
| Service de vision saturé ou étiquette illisible (sortie) | *Chercher dans la cave*, recherche pré-remplie si quelque chose a été lu |
| Envoi de la photo impossible | Message, *Réessayer* ou *Chercher dans la cave* |
| Double tap sur *Sortir* | Clé d'idempotence par écran de confirmation ; bouton désactivé pendant l'envoi ; index unique par photo |
| Mauvaise sortie | *Annuler* après la sortie, ou annulation depuis le journal (mouvement inverse) |
| Inventaire invalide (négatif, décimal, vide) | Refusé dans le formulaire et par l'API (`400`) |
| Vin inconnu (`/cave/:id`) | Page « Vin introuvable » avec retour à la cave |

## Tests

- **API (unitaires)** : `createOut` (création, idempotence, stock insuffisant →
  `409`, même photo deux fois → première sortie) ; inventaire (écart nul,
  positif, négatif, entrée invalide) ; `rankExitCandidates` (cas de référence
  ci-dessus) ; similarité trigramme ; exclusion des photos de sortie dans la
  revue groupée, le compteur d'attente et la reprise au démarrage ; politique
  de file `EXIT` (pas de report, échec à la dernière tentative) ;
  `createIn` renseigne la photo de référence.
- **Intégration** (PostgreSQL de la CI) : stock jamais négatif sur une sortie ;
  index unique d'une sortie par photo ; deux inventaires simultanés aboutissent
  à un stock cohérent ; migration de rattrapage des photos de référence.
- **Interface** : liste (recherche, filtre couleur, épuisés masqués puis
  affichés, `?q=`) ; fiche vin (sortie, correction avec écart annoncé, stock
  insuffisant) ; sortie par photo dans ses trois issues ; basculement vers la
  liste après `EXIT_FALLBACK_MS` et après échec ; activation de l'onglet *Cave*,
  de l'onglet *Sortie* et du bouton d'accueil.
- **Essai dans le navigateur** de chaque écran à largeur de téléphone.

## Livraison

- Commits `feat:` → version **1.2.0** via release-please.
- Aucune nouvelle variable d'environnement, aucun changement du
  `docker-compose.yml` : la stack reste autonome et le job `compose` de la CI
  reste vert. Déploiement : `docker compose pull && docker compose up -d`, la
  migration s'applique au démarrage de l'api.
- README (fonctionnalités, limites, journal) et CHANGELOG mis à jour en
  français.

## Hors périmètre

- Apogée (2b) et cote iDealwine (2c).
- Sortie hors ligne (réseau toujours disponible dans la cave).
- Reconnaissance visuelle automatique (empreintes d'images, arbitrage par le
  modèle) : à reconsidérer seulement si l'usage montre beaucoup de cas
  `SEVERAL`.
- Mesure automatique du temps de sortie.
- Emplacements dans la cave (lot 3 du cahier des charges).
