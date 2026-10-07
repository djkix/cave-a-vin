# Cave & Terroir — Design : une cave par compte, membres en lecture seule

2026-10-07 · Franck Laval

## Contexte

Jusqu'ici l'application est mono-cave : tout compte connecté (Google ou secours)
lit et modifie la même cave, et toute adresse Google qui se connecte obtient un
compte actif. Franck veut que **chaque compte ait sa propre cave**, que les
inscriptions soient **validées par lui**, et que chaque propriétaire puisse
**inviter des membres en lecture seule**.

## Décisions prises

| Question | Décision |
| --- | --- |
| Inscription | Toute adresse Google peut s'inscrire ; le compte reste **en attente** jusqu'à validation par un administrateur, qui crée alors sa cave |
| Membres | Le **propriétaire** d'une cave invite une adresse Google en **lecture seule** ; l'invitation suffit pour se connecter (pas de validation) ; retrait possible |
| Plusieurs caves | Oui, **sélecteur de cave** dans l'en-tête |
| Vue d'un membre | **Cave, fiches vin, statistiques** (recherche par plat comprise) ; pas de journal, pas d'export, **pas de prix d'achat** ; aucune écriture |
| Partagé | Référentiel des appellations, règles d'apogée, **descriptifs de domaine** : communs, gérés par l'administrateur |
| Budget Gemini | Plafond mensuel global inchangé **+ part maximale par cave** (20 % par défaut, réglable en admin), sauf pour la cave de l'administrateur principal |
| Existant | Devient **« Cave de Franck »**, propriété du premier administrateur ; les autres comptes actuels en deviennent **membres** |
| Approche | Colonne `cave_id` + garde d'accès central + filtrage systématique dans les services (pas de RLS PostgreSQL, pas de schéma par cave) |

## 1. Comptes

- `app_user.status` gagne `PENDING` (en plus de `ACTIVE`, `BLOCKED`).
- Connexion Google d'une adresse inconnue :
  - adresse dans `ADMIN_EMAILS` → `ACTIVE`, administrateur (comme aujourd'hui) ;
  - adresse invitée par un propriétaire (ligne `cave_member` avec `invited_email`)
    → `ACTIVE`, rattachée à ses invitations (le compte remplace l'adresse dans
    `cave_member`) ;
  - sinon → `PENDING`.
- Un compte `PENDING` obtient une session limitée : `GET /api/auth/me` renvoie
  `status: 'PENDING'` ; toute autre route répond 403 « Inscription en attente de
  validation ». L'écran affiche « Inscription en attente de validation — vous
  serez prévenu… » (pas d'envoi de mail : il suffit de revenir).
- Administration, section **Inscriptions** : liste des comptes `PENDING` (nom,
  e-mail, date) avec *Valider* (→ `ACTIVE` + création de « Cave de {nom affiché
  ou e-mail} » dont il est `OWNER`) et *Refuser* (→ `BLOCKED`).
- Un compte `ACTIVE` sans cave (invité seulement) n'a pas de cave à lui ; il
  n'en obtient une que si un administrateur la crée (*Créer sa cave* dans la
  liste des comptes).
- Le compte de secours reste administrateur ; s'il n'a pas de cave, il n'en a
  pas besoin.

## 2. Caves, rôles, sélecteur

- Tables : `cave (id, name, owner_id, created_at)` et
  `cave_member (id, cave_id, user_id NULL, invited_email NULL, role OWNER|VIEWER,
  created_at)`, avec unicité (cave, user) et (cave, invited_email), et un seul
  `OWNER` par cave (le propriétaire est aussi une ligne `OWNER`).
- **Cave courante** : choisie par le compte, mémorisée dans la session
  (`req.session.caveId`) ; par défaut sa cave `OWNER`, sinon la plus ancienne
  invitation. `GET /api/auth/me` renvoie `caves: [{ id, name, role }]` et
  `currentCaveId`. `PUT /api/auth/current-cave { caveId }` change la cave
  courante (404 si non accessible).
- **Garde d'accès** (`CaveAccessGuard` + décorateur `@CaveRole('OWNER' |
  'VIEWER')`) sur toutes les routes de cave : résout la cave courante et le rôle ;
  aucun accès → 404 « Cave introuvable » ; rôle insuffisant → 403 « Lecture
  seule ». Le contexte (`caveId`, `role`) est injecté dans les contrôleurs et
  passé aux services.
- **Gestion des membres** (propriétaire) : `GET /api/caves/current/members`,
  `POST /api/caves/current/members { email }` (invitation `VIEWER`, adresse
  normalisée en minuscules ; si un compte existe déjà avec cette adresse, il est
  rattaché directement ; 409 si déjà membre), `DELETE
  /api/caves/current/members/:id` (pas le propriétaire), `PATCH
  /api/caves/current { name }` (1 à 80 caractères).

## 3. Ce que chaque rôle peut faire

| Fonction | OWNER | VIEWER |
| --- | --- | --- |
| Liste de la cave, filtres, recherche par plat, fiche vin (apogée, note, accords, domaine) | oui | oui |
| Statistiques | oui | oui, **sans** valeur au prix d'achat ni classement « les plus chères » (champs absents de la réponse) |
| Prix d'achat (fiche, liste, mouvements) | oui | **non** (champs absents) |
| Journal, export Excel | oui | non (403) |
| Entrée, sortie, inventaire, « À confirmer », photos, recherche d'image, note, apogée manuelle, régénérer les accords | oui | non (403) |
| Images des photos | celles de ses caves | celles des caves où il est membre |
| Descriptifs de domaine : lecture | oui | oui |
| Descriptifs de domaine : écrire / régénérer, règles d'apogée, inscriptions, budget | administrateur seulement | administrateur seulement |

## 4. Données et migration

- `cave_id TEXT NOT NULL REFERENCES cave(id)` sur `wine`, `photo`, `export_log`,
  `image_search_cost` (index sur `cave_id`). Mouvements, notes, accords suivent le
  vin ; les descriptifs (`producer_profile`) restent communs.
- Unicités par cave : `wine(cave_id, match_key)` remplace `wine.match_key`
  unique ; `photo(cave_id, content_hash)` remplace `photo.content_hash` unique ;
  `movement.idempotency_key` reste globalement unique (clé aléatoire).
- Réglage `app_setting(key, value)` avec `cave_budget_share` = `0.2`.
- Migration de l'existant, en une transaction SQL :
  1. créer la cave « Cave de Franck » (nom « Cave de {display_name ou e-mail} »
     du propriétaire) appartenant au **premier compte administrateur** (le plus
     ancien `is_admin = true` non `is_break_glass`, sinon le compte de secours) ;
     s'il n'existe aucun compte, la cave est créée sans propriétaire et sera
     attribuée au premier administrateur qui se connecte ;
  2. renseigner `cave_id` de toutes les lignes existantes ;
  3. ajouter les autres comptes actifs comme `VIEWER` ;
  4. poser les contraintes NOT NULL et les nouvelles unicités.
- Base vide (installation neuve) : rien à migrer.

## 5. Services et worker

- Tous les services de cave reçoivent `caveId` et filtrent : cave (liste,
  fiche, filtres, recherche par plat), mouvements (entrée, sortie, inventaire,
  annulation, journal), rapprochement des vins (`matchOrCreate` dans la cave),
  photos (envoi, image, « À confirmer », écarter, événements temps réel,
  file d'attente), recherche d'image, notes, apogée manuelle, accords
  (régénérer), statistiques, export, qualité de lecture (admin : toutes caves).
- Un identifiant (vin, photo, mouvement, candidate) d'une autre cave est traité
  comme inexistant (404).
- Worker : un lot d'entrée ne contient que des photos d'une même cave ; le coût
  est porté par les photos (donc par la cave). Accords et descriptifs inchangés.
- Budget : `assertUnderCap()` global inchangé ; en plus, pour une cave qui n'est
  pas celle du premier administrateur, `spentThisMonthCents(caveId) >= cap ×
  share` → report (comme le plafond global, message « Part mensuelle de cette
  cave atteinte — reprise le mois prochain »). Section admin « Budget » :
  part par cave (0 à 100 %).

## 6. Écrans

- Écran d'attente pour un compte `PENDING`.
- En-tête : sélecteur de cave (si plusieurs) avec la mention « (lecture) ».
- Pour un `VIEWER` : onglets Entrée, Sortie, Journal masqués ; pas de badge « à
  confirmer », pas de boutons d'action sur la fiche (note, corriger, régénérer,
  chercher une image, inventaire, sortie) ; statistiques sans prix ; export absent.
- Écran **Membres** (propriétaire, depuis l'accueil) : liste, inviter une adresse,
  retirer, renommer la cave.
- Administration : **Inscriptions** (valider / refuser), *Créer sa cave* sur un
  compte, **Budget** (part par cave), le reste inchangé.

## 7. Erreurs

| Situation | Réponse |
| --- | --- |
| Compte en attente | 403 « Inscription en attente de validation » |
| Cave non accessible | 404 « Cave introuvable » |
| Écriture d'un membre | 403 « Lecture seule » |
| Ressource d'une autre cave | 404 (message habituel de la ressource) |
| Invitation déjà présente | 409 « Cette adresse est déjà membre » |
| Retirer le propriétaire | 400 « Le propriétaire ne peut pas être retiré » |

## 8. Tests

- Migration sur une base remplie au format actuel (toutes les lignes rattachées,
  membres créés, unicités posées).
- Comptes : Google inconnu → PENDING ; admin → ACTIVE ; invité → ACTIVE +
  rattaché ; valider / refuser.
- **Étanchéité, route par route** : deux caves A et B, un propriétaire de A, un
  membre de A, un propriétaire de B ; chaque route de cave vérifiée (propriétaire
  OK, membre lecture OK / écriture 403, étranger 404, ressources croisées 404,
  prix absents pour le membre).
- Worker : lots mono-cave ; budget par cave.
- Écrans : attente, sélecteur, lecture seule, membres, inscriptions, budget.
- Essai navigateur 375 px avec deux comptes.

## 9. Livraison

- Version **2.0.0** (changement de fonctionnement pour tous les comptes) ;
  notes de version : **faire une sauvegarde de la base avant la mise à jour**.
- Aucune nouvelle variable d'environnement.
- README (fonctionnalités, administration, limites, journal) et CHANGELOG en
  français ; le cahier des charges est annoté (« mono-cave » → multi-caves).
