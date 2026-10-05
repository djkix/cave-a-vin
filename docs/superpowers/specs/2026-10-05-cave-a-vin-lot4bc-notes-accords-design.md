# Cave & Terroir — Design Lots 4b et 4c : note de dégustation et accords mets-vins

2026-10-05 · Franck Laval

## Contexte

Cahier des charges source : [`cahier-des-charges.md`](../../../cahier-des-charges.md),
lot 4 (« Notes de dégustation, accords mets-vins »). Le lot 4a (statistiques) est
livré en 1.6.0. Ce document fixe le périmètre des **lots 4b et 4c**, conçus et
livrés ensemble, et les **décisions prises** en conception.

## Intention

- **4b** : garder l'impression laissée par un vin, d'un chiffre, pour s'en
  souvenir au moment de racheter ou d'ouvrir.
- **4c** : savoir avec quoi servir un vin, et, dans l'autre sens, quoi ouvrir
  pour un plat donné — sans rien saisir : les accords sont suggérés par Gemini.

## Décisions prises

| Question | Décision | Conséquence |
| --- | --- | --- |
| Moment de la note | **Depuis la fiche vin seulement** | La sortie reste inchangée |
| Contenu de la note | **Note sur 20 seulement** (demi-points), sans commentaire ni plat | Aucun « accord vécu » : le 4c repose sur Gemini |
| Nombre de notes | **Une seule note par vin**, remplaçable et retirable | Colonnes sur la table `wine`, pas de table dédiée |
| Droits sur la note | Tout compte actif | Geste courant, comme la correction de l'apogée |
| Source des accords | **Suggestions Gemini**, présentées comme telles | Un appel texte par vin |
| Génération | **Automatique, en tâche de fond** (nouvelle file BullMQ), rattrapage au démarrage, bouton *Regénérer* | La recherche par plat couvre toute la cave |
| Recherche par plat | **Oui, dans l'onglet Cave** (« Accompagner un plat ») | `GET /api/cave?dish=` |
| Statistiques | Classement **« Les mieux notés »** | 4e classement de la page Stats |

## 4b — La note de dégustation

### Données

Migration ajoutant à `wine` trois colonnes facultatives :

- `rating` `NUMERIC(3,1)` : note de 0 à 20, par pas de 0,5 (contrainte `CHECK`
  `rating >= 0 AND rating <= 20 AND rating * 2 = TRUNC(rating * 2)`) ;
- `rated_at` `TIMESTAMP(3)` ;
- `rated_by` `TEXT` référençant `app_user(id)` (`ON DELETE SET NULL`).

Les trois sont vides ensemble (vin non noté) ou renseignées ensemble.

### API

| Méthode et route | Droits | Entrée | Réponse |
| --- | --- | --- | --- |
| `PUT /api/wines/:id/rating` | session | `{ rating }` | `rating` du vin |
| `DELETE /api/wines/:id/rating` | session | — | `rating: null` |
| `GET /api/cave`, `GET /api/wines/:id` | session | — | chaque vin porte `rating: { value, ratedAt, ratedBy } \| null` (`ratedBy` : nom affiché, sinon e-mail du compte ; `null` si le compte n'existe plus) |

Validation (messages en français) : `rating` nombre de 0 à 20, multiple de 0,5
— « La note doit être comprise entre 0 et 20 », « La note se donne par
demi-point ». Vin inconnu : `404` « Vin introuvable ».

### Écrans

- **Fiche vin**, bloc « Ma note » sous le bloc Apogée :
  - sans note : bouton *Noter ce vin* ;
  - avec une note : « 16,5 / 20 » puis « notée le 5 oct. 2026 par Franck »,
    boutons *Modifier* et *Retirer* ;
  - saisie : champ numérique (pas 0,5), validation dans le formulaire et par
    l'api, *Enregistrer* / *Annuler*.
- **Onglet Cave** : la note s'affiche sur la ligne (« 16,5/20 ») quand elle
  existe.
- **Export Excel**, feuille *Stock* : colonne *Note /20* après *Confiance*.
- **Statistiques** : 4e classement **« Les mieux notés »** — les 5 vins à la
  meilleure note, en stock ou non, départagés par producteur ; champ API
  `bestRated: RankedWine[]` (`value` = note).

## 4c — Les accords mets-vins

### Données

Table `pairing` :

| Colonne | Type | Rôle |
| --- | --- | --- |
| `id` | `TEXT` (uuid) | clé |
| `wine_id` | `TEXT` unique, référence `wine(id)` `ON DELETE CASCADE` | un jeu d'accords par vin |
| `status` | `PENDING` \| `DONE` \| `FAILED` | état de la génération |
| `dishes` | `TEXT[]` | plats suggérés (vide tant que pas `DONE`) |
| `model` | `TEXT` | modèle Gemini utilisé |
| `cost_cents` | `INTEGER` | coût de l'appel |
| `error_message` | `TEXT` | raison d'un échec, en français |
| `generated_at` | `TIMESTAMP(3)` | date de la dernière génération réussie |
| `updated_at` | `TIMESTAMP(3)` | dernière modification |

### Génération

- **File** : nouvelle file BullMQ `wine-pairing`, traitée par le worker
  existant (concurrence 1). Un travail porte `{ wineId }` ; son identifiant de
  travail est `pairing-<wineId>`, pour ne jamais mettre deux fois le même vin
  en file.
- **Déclencheurs** :
  1. création d'un vin par `MovementsService.createIn` (entrée unitaire,
     campagne, saisie manuelle) quand le rapprochement crée une nouvelle
     fiche ;
  2. **rattrapage au démarrage du worker** : tout vin sans ligne `pairing`, ou
     dont la ligne est `PENDING`, est mis en file (couvre les vins existants à
     la mise à jour) ;
  3. **`POST /api/wines/:id/pairing/regenerate`** (tout compte actif) : passe
     la ligne à `PENDING` et met le vin en file ; répond `202`.
- **Appel** : Gemini en mode texte, même clé (`GEMINI_API_KEY`) et même modèle
  que l'analyse des photos. Entrée : producteur, cuvée, appellation, région,
  couleur, millésime. Consigne : 5 à 8 plats courts, en français, accordés à
  ce vin ; réponse JSON `{ "plats": string[] }`.
- **Vérification de la réponse** : 1 à 8 libellés, chacun non vide après
  rognage, 60 caractères au plus, doublons retirés (sans tenir compte des
  accents ni des majuscules). Une réponse invalide est un **échec définitif**
  (`FAILED`, « Réponse de Gemini inexploitable »).
- **Jamais bloquant** : une indisponibilité passagère de Gemini (même critère
  que `isTransientVisionFailure`) relance le travail avec la même attente
  croissante que les photos (30 s doublée jusqu'à 15 min, sans limite de
  tentatives) ; la ligne reste `PENDING`. Une génération n'empêche jamais une
  entrée ou une sortie.
- **Budget** : le plafond mensuel `GEMINI_MONTHLY_CAP_CENTS` compte désormais
  la somme des coûts des photos **et** des accords du mois. Plafond atteint :
  le travail d'accords est relancé plus tard (il attend), sans échec.

### Recherche par plat

- `GET /api/cave?dish=<texte>` (max 100 caractères) : garde les vins dont **au
  moins un plat** contient **tous les mots** saisis, sans accents ni
  majuscules (même normalisation que la recherche actuelle). Se combine avec
  `q`, `color`, `includeEmpty`, `drinkSoon`, `noApogee`.
- **Tri** quand `dish` est présent : les vins à boire en priorité (fin
  d'apogée au plus tard l'an prochain) d'abord, par fin d'apogée ; puis les
  autres dans l'ordre habituel (producteur, millésime).
- Chaque vin de la réponse porte `matchedDish` : le premier plat qui
  correspond.

### API (accords)

| Méthode et route | Droits | Réponse |
| --- | --- | --- |
| `GET /api/wines/:id` | session | le vin porte `pairing: { status, dishes, errorMessage, generatedAt } \| null` |
| `POST /api/wines/:id/pairing/regenerate` | session | `202` ; `404` « Vin introuvable » |
| `GET /api/cave?dish=` | session | liste filtrée, chaque vin avec `matchedDish` |

### Écrans

- **Fiche vin**, bloc « Accords mets-vins » sous « Ma note » :
  - `DONE` : les plats en pastilles, la mention « Suggestions générées par
    Gemini », bouton *Regénérer* ;
  - `PENDING` ou pas encore de ligne : « Suggestions en préparation… », la
    fiche se rafraîchit toutes les 5 s tant que l'état reste en attente ;
  - `FAILED` : « Suggestions indisponibles » et la raison, bouton
    *Regénérer*.
- **Onglet Cave** : champ **« Accompagner un plat »** sous la recherche ; sur
  chaque ligne trouvée, mention « avec : {matchedDish} ».
- **Export Excel**, feuille *Stock* : colonne *Accords* (plats séparés par
  « ; ») en dernière colonne.

## Erreurs

| Situation | Comportement |
| --- | --- |
| Note hors bornes ou pas un demi-point | `400`, message français ; refusée aussi dans le formulaire |
| Vin inconnu (note, régénération) | `404` « Vin introuvable » |
| Pas de session | `401` |
| Gemini indisponible ou plafond atteint | Travail relancé plus tard, ligne `PENDING`, rien de bloqué |
| Réponse Gemini invalide | `FAILED`, « Réponse de Gemini inexploitable », *Regénérer* possible |
| Paramètre `dish` trop long | `400` « Filtre de cave invalide » |

## Tests

- **Note** : validation (0, 20, 16,5 acceptés ; -1, 20,5, 16,3 refusés, au
  formulaire et à l'api), pose, remplacement, retrait, nom de l'auteur,
  affichage fiche et liste, colonne d'export, classement « Les mieux notés »
  (vin épuisé compris, départage).
- **Accords — vérification de la réponse** : liste valide, vide, trop longue,
  libellé trop long, doublons accentués, JSON invalide.
- **Accords — traitement** : succès (`DONE`, plats, coût), indisponibilité
  (relance, reste `PENDING`), plafond atteint (relance), réponse invalide
  (`FAILED`), vin supprimé entre-temps (travail ignoré).
- **Budget** : la somme mensuelle inclut les accords.
- **Déclencheurs** : création d'un vin → mise en file ; vin rapproché d'un
  existant → rien ; rattrapage au démarrage → uniquement les vins sans
  accords `DONE`/`FAILED` ; identifiant de travail unique par vin.
- **Recherche par plat** : accents, majuscules, plusieurs mots, combinaison
  avec les filtres, tri (priorité d'abord), `matchedDish`.
- **Bout en bout** (PostgreSQL de la CI) : `PUT`/`DELETE` rating, contrainte
  `CHECK` en base, `POST …/pairing/regenerate`, `GET /cave?dish=`, `401` sans
  session.
- **Interface** : bloc « Ma note » (affichage, saisie, validation, retrait),
  bloc « Accords » dans ses trois états et *Regénérer*, champ « Accompagner un
  plat », classement « Les mieux notés ».
- **Essai dans le navigateur** à 375 px.

## Livraison

- Commits `feat:` → version **1.7.0** via release-please, avec la correction
  du soulignement des barres d'apogée déjà fusionnée.
- Deux migrations (note sur `wine`, table `pairing`), appliquées au démarrage
  de l'api.
- Aucune nouvelle variable d'environnement ; `docker-compose.yml` inchangé.
- README (fonctionnalités, limites, journal) et CHANGELOG en français.

## Hors périmètre

- Commentaire de dégustation, plat servi, historique des notes, notes par
  compte.
- Accords saisis à la main ou corrigés plat par plat.
- Note à la sortie.
- Emplacements, cote iDealwine (reportés).
