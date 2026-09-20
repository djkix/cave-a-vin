# Cave & Terroir — Design Lot 0 + Lot 1

2026-09-20 · Franck Laval

## Contexte

Cahier des charges source : [`cahier-des-charges.md`](../../../cahier-des-charges.md)
(reconstruit depuis le doc Claude fourni par l'utilisateur). Ce document ne le
répète pas ; il précise le **périmètre retenu pour cette première livraison**
(Lot 0 + Lot 1 du cahier des charges), les **décisions prises** sur les points
que le cahier des charges laissait ouverts, et le **design system consolidé**
à partir des maquettes fournies. Les lots 2 à 4 (sortie par photo, apogée,
cote iDealwine, emplacements, alertes, valorisation, dégustation) restent
définis par le cahier des charges et seront repris dans des specs séparées le
moment venu.

Application auto-hébergée : nouveau repo public `djkix/cave-a-vin`, déployé
sur le même Proxmox/homelab que [`djkix/magazine-search`](https://github.com/djkix/magazine-search),
dont les conventions d'hébergement (Docker Compose, images GHCR, Nginx Proxy
Manager, sauvegardes) sont reprises telles quelles.

## Décisions prises (points laissés ouverts par le cahier des charges)

| Question ouverte | Décision |
| --- | --- |
| Construire ou adapter un outil existant ? | Construire (aucun outil auto-hébergé ne fait de reconnaissance photo) |
| Modèle de vision | **Google Gemini** (`GEMINI_API_KEY`), cohérent avec `magazine-search` qui l'utilise déjà pour l'extraction de sommaires |
| Existe-t-il une liste de cave existante ? | Non → le **mode campagne** (rafale + revue groupée) fait partie du Lot 1, pas l'import CSV |
| Charte graphique | 4 maquettes HTML/Tailwind fournies (palette bronze/doré "Bastide Provençale & Travertin Doré") → consolidées ci-dessous ; voir [`docs/design-reference/`](../../design-reference/) |
| Nom du repo | `cave-a-vin`, public, sous le compte GitHub `djkix` |
| Déploiement effectif sur le serveur | Cette session n'a pas d'accès SSH au homelab : le repo est livré prêt à déployer (comme `magazine-search`), le `docker compose pull && up` final reste manuel côté utilisateur |

## Périmètre — Lot 0 + Lot 1

**Ce qui est construit maintenant :**

- **Lot 0 (socle).** Docker Compose (`web`, `api`, `worker`, `db`, `redis`),
  connexion Google OAuth avec liste blanche (`allowed_email`), compte de
  secours local (argon2), PWA installable vide, CI (lint, tests, build
  d'images GHCR).
- **Lot 1 (entrée de stock).**
  - Écran d'accueil : bouton *Rentrer* actif ; *Sortir* et *Cave* visibles
    mais marqués « Bientôt disponible » (lot 2) pour ne pas mentir sur l'état
    du produit.
  - Flux Entrée complet : photo (carton ou bouteille) → normalisation
    (redressement, JPEG 85, 1600px max, suppression GPS) → extraction Gemini
    (JSON strict + confiance par champ) → recalage sur référentiel
    d'appellations (`pg_trgm`) → dédoublonnage par clé de matching → écran de
    confirmation éditable → sélecteur de quantité (1/6/12/18 + libre) →
    mouvement `IN`.
  - **Mode campagne** : capture en rafale sans confirmation unitaire, file de
    traitement en arrière-plan (4-6 photos en parallèle, back-off sur 429),
    écran de revue groupée trié par confiance croissante.
  - Mode hors ligne : file locale IndexedDB (plafond 20 photos / 50 Mo),
    vidage au premier plan / événement `online`, compteur de photos en
    attente toujours visible.
  - Historique des 20 derniers mouvements avec annulation en un tap (mouvement
    inverse, rien n'est supprimé).
  - Export Excel à la demande (3 feuilles : Stock, Mouvements, Référence),
    filtre optionnel.

**Explicitement hors de cette livraison (Lot 2+, cahier des charges) :**
sortie de stock (photo ou manuelle depuis une liste), estimation de l'apogée,
relevé de cote iDealwine, emplacements, alertes, valorisation, notes de
dégustation. Les maquettes `03-sortie-matching.html` et une partie de
`04-fiche-vin.html` (apogée, cote) sont des références visuelles pour ces
lots futurs, pas des écrans construits maintenant — inclure la jauge
d'apogée dans l'écran de confirmation d'entrée serait cohérent avec le
référentiel déjà chargé en Lot 1, mais reste reporté pour garder un
périmètre net et testable.

**Conséquence assumée :** en Lot 0+1, la seule vue d'ensemble de la cave est
l'export Excel et l'historique des mouvements — pas de liste de stock
consultable dans l'app. C'est le compromis qui garde le lot testable en
suivant strictement le critère de fin du cahier des charges : *« un carton de
12 est rentré en moins de 60 s et figure dans le classeur exporté »*.

## Modèle de données (tables nécessaires au Lot 0+1)

Repris tel quel du cahier des charges, restreint aux tables utilisées par ce
périmètre :

- `wine` — référence vin dédoublonnée (`match_key` unique, producteur,
  cuvée, appellation_id, millésime, couleur, format_cl). Les colonnes
  `apogee_min/max/source` et `idealwine_ref` existent dans le schéma dès
  maintenant (nullable) pour éviter une migration de colonnes lors du Lot 2,
  mais ne sont pas renseignées par du code applicatif avant ce lot.
- `movement` — journal append-only (`wine_id`, `delta`, `type` IN/ADJUST au
  Lot 1 — `OUT` existe dans l'enum mais n'est produit qu'au Lot 2, `occurred_at`,
  `photo_id`, `price_unit`, `note`).
- `photo` — image + résultat brut (`raw_extraction` JSONB, `model`,
  `latency_ms`, `cost_cents`).
- `app_user`, `allowed_email` — auth Google.
- `export_log` — trace des exports générés.
- `appellation` — référentiel INAO (nom canonique, région, couleurs,
  garde_min, garde_max — les colonnes de garde sont chargées au déploiement
  mais inutilisées avant le Lot 2).

Règles d'intégrité : `movement.delta` non nul ; stock jamais négatif
(trigger) ; `photo.raw_extraction` conservée telle quelle pour permettre de
rejouer l'extraction ; vue matérialisée `stock_courant` rafraîchie à chaque
mouvement.

## Pipeline de reconnaissance (Gemini)

Identique au cahier des charges, avec Gemini comme fournisseur : le `worker`
appelle l'API Gemini via BullMQ (jamais en synchrone sur l'API), le schéma de
sortie JSON strict et les règles (pas de champ inventé, confiance par champ,
distinction producteur/cuvée, lecture du nombre de cols sur carton) sont
repris tels quels. Le résultat est poussé au client par SSE. L'appel est
caché derrière une interface `VisionProvider` pour permettre de changer de
fournisseur sans toucher au reste du pipeline (même principe que
`PriceProvider` dans le cahier des charges pour iDealwine).

## Architecture & déploiement

Stack : NestJS/TypeScript (`api` + `worker` BullMQ), React + Vite en PWA
(`web`), PostgreSQL 16 + `pg_trgm`, Redis 7. Stockage photo sur volume local
Docker (MinIO reporté).

Conventions d'hébergement reprises de `magazine-search` :

- Images publiées sur `ghcr.io/djkix/cave-a-vin-api`,
  `ghcr.io/djkix/cave-a-vin-web` via GitHub Actions
  (`ci.yml` lint/tests, `docker-build.yml` build+push sur tag/`main`,
  `release-please.yml` versioning + changelog).
- Un seul port publié sur l'hôte (`web`, qui relaie `/api/*` en interne) ;
  `api`/`worker`/`db`/`redis` restent sur le réseau Docker `internal`.
- Secrets via `.env` (jamais dans l'image ni le dépôt) : `GEMINI_API_KEY`,
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
  `POSTGRES_PASSWORD`.
- `db-backup` : `pg_dump` quotidien compressé vers le NAS (comme
  `magazine-search`), rétention 30 jours (cahier des charges) au lieu de 14.
- Exposition via le Nginx Proxy Manager déjà en place (nouveau sous-domaine à
  créer côté NPM, hors du périmètre de ce repo).

## Design system consolidé — Cave & Terroir

Construit à partir des 4 maquettes fournies (voir
[`docs/design-reference/`](../../design-reference/)), réconciliées sur la
palette bronze/doré dominante et alignées sur les couleurs déjà nommées dans
le cahier des charges (doré chêne `#A37943` = action d'entrée, ferronnerie
noire `#2B2621` = action de sortie/validation).

**Couleurs (tokens sémantiques, mode clair) :**

| Token | Valeur | Usage |
| --- | --- | --- |
| `primary` | `#7A5522` | Texte/icônes d'accent, liens |
| `primary.action` | `#8B612C` | Fond des boutons texte pleine largeur (contraste ~5,5:1 en blanc) |
| `primary.container` | `#A37943` | Badges, pastilles, aplats sans texte (doré chêne) |
| `ferronnerie` (`iron-dark`) | `#2B2621` | Bouton *Sortir*, dock d'action principal, texte inversé |
| `background` / `surface` | `#FCF9F3` | Fond de page |
| `surface.container.lowest` | `#FFFFFF` | Cartes |
| `surface.container` / `.low` / `.high` | `#F0EEE8` / `#F6F3ED` / `#EBE8E2` | Fonds étagés |
| `outline.variant` | `#D3C4B5` / `#E6DFD3` | Séparateurs, bordures de carte |
| `secondary` (texte atténué) | `#635D5A` | Libellés, méta-informations |
| `error` | `#BA1A1A` | États d'erreur |

Mode sombre (« mode cave ») : à construire en Lot 2 quand les écrans
concernés (apogée, cote) existeront — non nécessaire pour le Lot 1 dont les
écrans sont peu nombreux et utilisés en intérieur éclairé.

**Typographie :** Noto Serif pour les noms de domaine/cuvée/appellation et
les titres d'écran ; Manrope (sans-serif) pour tous les chiffres, quantités,
labels et formulaires — jamais l'inverse, les chiffres elzéviriens de Noto
Serif s'alignent mal en colonne. Icônes : Material Symbols Outlined.

**Specs tactiles :** cible tactile minimale 48px (pilules de quantité
1/6/12/18 à 50-56px de haut dans les maquettes), en-tête 56px (`h-14`), barre
de navigation basse 64px (`h-16`) avec `pb-safe`/`env(safe-area-inset-bottom)`,
boutons d'action principaux ancrés en bas à 52-54px de haut.

**Composants Lot 1 à construire** (d'après les maquettes) :
- Bandeau photo + statut d'extraction (badge de confiance, bouton reprendre) ;
- Carte fiche vin extraite : champ + valeur + badge de confiance par champ,
  éditable au tap ;
- Sélecteur de quantité en pilules tactiles (1 / 6 / 12 / 18 / Autre), avec
  pré-sélection si une quantité a été lue sur le carton ;
- Accordéon « Détails d'affectation » (prix d'achat, caviste — repliable,
  ouvert par défaut) ;
- Bandeau file hors ligne (« 2 photos en attente » + bouton *Forcer le
  push*) ;
- Liste d'historique des mouvements avec bouton *Annuler* par ligne ;
- Bouton d'action principal ancré en bas (fond ferronnerie, icône +
  libellé dynamique reflétant la quantité).

## Exigences non fonctionnelles (reprises du cahier des charges, applicables au Lot 1)

- Entrée complète (photo → export à jour) en moins de 60 s pour un carton.
- Extraction en moins de 10 s au 90e centile.
- Aucune perte de photo, même hors ligne.
- Idempotence : hash de contenu par photo, clé d'idempotence client par
  mouvement — une double soumission ne crée jamais deux mouvements.

## Points restant ouverts pour le Lot 1 (à trancher en implémentation, non bloquants pour cette spec)

- Domaine du sous-domaine NPM exact (ex. `cave.<domaine>.fr`) — à donner par
  l'utilisateur au moment du déploiement.
- Client OAuth Google (`GOOGLE_CLIENT_ID`/`SECRET`) — à créer par
  l'utilisateur dans Google Cloud Console (accès externe requis, non
  automatisable depuis cette session) ; adresses à mettre dans
  `allowed_email` au premier déploiement.
- Plafond mensuel de dépense Gemini — valeur par défaut proposée en
  implémentation, ajustable en configuration.
