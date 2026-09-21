# Cave & Terroir

Gestion de cave à vin sans saisie clavier : une photo à l'achat crédite le stock,
une photo au moment de boire le débite, et un classeur Excel exportable donne à
tout moment l'état complet de la cave. Application auto-hébergée en Docker,
utilisée depuis un téléphone (PWA installable).

- **URL publique** : <https://cave.djkix.ovh/>
- **État** : lot 0 + lot 1 livrés — socle, entrée de stock par photo (Gemini),
  mode campagne, file hors ligne, journal et export Excel.
- **À venir (lot 2)** : sortie de stock par photo, estimation de l'apogée, cote
  iDealwine. Voir `cahier-des-charges.md`.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Architecture et ports](#architecture-et-ports)
- [Déploiement](#déploiement)
- [Mise à jour](#mise-à-jour)
- [Sauvegarde et restauration](#sauvegarde-et-restauration)
- [Développement](#développement)
- [Limites du lot 1](#limites-du-lot-1)
- [Journal des modifications](#journal-des-modifications)
- [Stack technique](#stack-technique)

## Fonctionnalités

**Entrée de stock par photo.** Bouton *Rentrer*, l'appareil photo du téléphone
s'ouvre, la photo part vers le serveur et l'analyse se fait en arrière-plan. La
fiche revient pré-remplie (domaine, cuvée, appellation, millésime, couleur,
format) avec un indicateur de confiance par champ ; les champs douteux sont
surlignés. La quantité se choisit en un tap (1 · 6 · 12 · 18 ou libre) et le
nombre de cols lu sur le carton est présélectionné. Rien n'est écrit en stock
avant la validation explicite.

**Mode campagne.** Pour reprendre une cave existante : photo, suivant, photo,
suivant, sans confirmation unitaire. Un écran de revue groupée liste ensuite les
fiches extraites, les moins fiables en premier, et une seule validation crée tous
les mouvements.

**Hors ligne.** La cave est souvent un sous-sol sans réseau : les photos sont
mises en file dans le navigateur (20 photos ou 50 Mo maximum) et envoyées dès que
l'application est rouverte avec du réseau. Un compteur « N photos en attente »
reste visible.

**Journal et annulation.** Les 20 derniers mouvements sont consultables et
annulables en un tap. Une annulation écrit un mouvement inverse : rien n'est
jamais supprimé, l'historique reste vrai.

**Export Excel.** Un classeur `.xlsx` à la demande, régénéré intégralement à
chaque fois, avec trois feuilles (`Stock`, `Mouvements`, `Référence`) et un filtre
optionnel par couleur.

**Garde-fous.** Stock jamais négatif (contrainte en base), journal en ajout seul,
idempotence de bout en bout (empreinte de contenu par photo, clé d'idempotence par
mouvement, un seul mouvement d'entrée par photo) et plafond mensuel de dépense
pour l'API de vision.

**Comptes et administration.** L'inscription est libre : n'importe quel compte
Google se connecte et a immédiatement accès complet à l'application. Le
propriétaire désigne un ou plusieurs administrateurs via `ADMIN_EMAILS`, et
bloque ensuite les comptes indésirables depuis l'espace `/admin` (liste des
comptes, blocage/réactivation, promotion/retrait des droits d'administration).
Un administrateur ne peut pas modifier son propre compte, pour ne jamais perdre
l'accès à l'administration par erreur.

## Architecture et ports

| Service | Rôle | Port | Exposition |
| --- | --- | --- | --- |
| `web` | nginx + PWA compilée, relaie `/api/` | **3100** sur l'hôte → 80 | **seul port publié** (`WEB_PORT`) |
| `api` | REST, authentification, règles métier, export | 3000 | réseau Docker interne |
| `worker` | extraction Gemini via BullMQ | — | réseau Docker interne |
| `postgres` | données (PostgreSQL 16 + `pg_trgm`) | 5432 | réseau Docker interne |
| `redis` | file de travaux et sessions | 6379 | réseau Docker interne |
| `db-backup` | `pg_dump` quotidien avec rotation | — | réseau Docker interne |

Seul le port `3100` est joint par Nginx Proxy Manager, qui termine TLS et garde
80/443. Aucune autre ouverture n'est nécessaire sur la box.

## Déploiement

### 1. Préparer l'hôte

Une VM ou un LXC avec 2 vCPU, 4 Go de RAM et 40 Go de disque suffit. Docker et le
plugin Compose installés ; le Nginx Proxy Manager existant doit pouvoir joindre
cette machine sur le réseau local.

### 2. Cloner le dépôt

```bash
git clone https://github.com/djkix/cave-a-vin.git /opt/cave-a-vin
```

Le dépôt doit être présent sur l'hôte : Compose monte `./ops/pg_backup.sh` et
écrit les sauvegardes dans `./backups`.

### 3. Créer le client OAuth Google

Dans la console Google Cloud, avec le compte qui possédera l'application :

1. Créer ou choisir un projet (<https://console.cloud.google.com/projectcreate>).
2. **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>) :
   nom de l'application, adresse de support, **audience External**, puis
   **Publish app**. Les scopes demandés se limitent à `openid`,
   `userinfo.email` et `userinfo.profile` : ce périmètre est exempté de
   vérification par Google, il n'y a donc aucune démarche à faire.
3. **Clients → Create client** (<https://console.cloud.google.com/auth/clients>),
   type **Application Web**, avec cet URI de redirection autorisé :
   `https://cave.djkix.ovh/api/auth/google/callback`
   (aucune origine JavaScript n'est nécessaire, le flux est côté serveur).
4. Relever le **Client ID** et le **Client secret**. Le secret ne se réaffiche
   pas : s'il est perdu, en créer un nouveau depuis la fiche du client.

**Règle ferme** : aucun autre scope ne doit jamais être demandé à ce client.
L'export étant un simple téléchargement, l'application n'a besoin d'aucun accès
à Drive ni à Sheets.

### 4. Renseigner le `.env`

```bash
cp /opt/cave-a-vin/.env.example /opt/cave-a-vin/.env
```

Générer les deux secrets :

```bash
openssl rand -hex 24
```

```bash
openssl rand -hex 32
```

| Variable | Valeur attendue |
| --- | --- |
| `WEB_PORT` | port publié sur l'hôte (défaut `3100`), cible du proxy |
| `IMAGE_TAG` | `latest`, ou un numéro de version (`1.0.0`) pour figer le déploiement |
| `POSTGRES_USER` / `POSTGRES_DB` | `cave` / `cave` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `SESSION_SECRET` | `openssl rand -hex 32` — 32 caractères minimum, l'api refuse de démarrer en dessous |
| `WEB_ORIGIN` | `https://cave.djkix.ovh` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | valeurs de l'étape 3 |
| `GOOGLE_CALLBACK_URL` | `https://cave.djkix.ovh/api/auth/google/callback`, **identique** à l'URI déclaré chez Google |
| `BREAK_GLASS_EMAIL` / `BREAK_GLASS_PASSWORD` | compte local de secours (mot de passe de 12 caractères minimum) ; laisser vide pour n'en créer aucun |
| `ADMIN_EMAILS` | adresses administratrices, séparées par des virgules, en minuscules ; seule façon de désigner un administrateur (voir étape 7) |
| `GEMINI_API_KEY` | clé Google AI Studio |
| `GEMINI_MODEL` | `gemini-3.5-flash` |
| `GEMINI_MONTHLY_CAP_CENTS` | plafond mensuel approximatif en centimes (`500` = ~5 €) |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` / `BACKUP_INTERVAL_SECONDS` | sauvegardes : répertoire, rétention, intervalle |

Le `.env` n'est jamais commité et n'entre jamais dans une image.

### 5. Récupérer les images

Les paquets GHCR sont privés par défaut, même si le dépôt est public. Soit
s'authentifier avec un jeton personnel disposant de `read:packages` :

```bash
echo <PAT> | docker login ghcr.io -u djkix --password-stdin
```

```bash
cd /opt/cave-a-vin && docker compose pull
```

… soit construire les images sur place, ce qui évite toute authentification :

```bash
cd /opt/cave-a-vin && docker compose build
```

### 6. Démarrer

```bash
cd /opt/cave-a-vin && docker compose up -d
```

Le conteneur `api` applique les migrations Prisma puis charge le référentiel des
appellations au démarrage — les deux opérations sont idempotentes et se rejouent
sans risque à chaque redémarrage. Vérification :

```bash
curl -s http://localhost:3100/api/health
```

La réponse attendue est `{"status":"ok"}`. En cas d'échec :
`docker compose logs api --tail 50`.

### 7. Désigner un administrateur

Le sous-domaine est public : depuis cette évolution, l'inscription est **libre**
— n'importe quel titulaire d'un compte Google peut se connecter et obtient un
accès complet immédiatement. C'est un choix assumé du propriétaire, qui bloque
ensuite les comptes indésirables au lieu de les filtrer à l'entrée.

La seule façon de désigner un administrateur est la variable `ADMIN_EMAILS` du
`.env` (adresses séparées par des virgules, en minuscules) : au moins la vôtre,
pour pouvoir ouvrir l'espace d'administration après le premier déploiement.

```bash
ADMIN_EMAILS=vous@gmail.com
```

Une fois connecté avec cette adresse, l'espace **Administration** (lien sur
l'accueil, ou `/admin`) liste tous les comptes créés et permet de bloquer un
compte indésirable, de le réactiver, ou de promouvoir/retirer d'autres
administrateurs. Un administrateur ne peut pas modifier son propre compte.

### 8. Configurer Nginx Proxy Manager

**Proxy Hosts → Add Proxy Host** :

- *Domain Names* : `cave.djkix.ovh`
- *Scheme* : `http` · *Forward Hostname / IP* : IP de la VM Docker · *Forward Port* : `3100`
- *Websockets Support* et *Block Common Exploits* activés
- Onglet **SSL** : certificat Let's Encrypt, *Force SSL* et HTTP/2 activés

NPM envoie `X-Forwarded-Proto: https`, que le nginx interne relaie tel quel :
c'est ce qui permet au cookie de session `Secure` d'être posé. **Ne pas** ajouter
`proxy_set_header X-Forwarded-Proto $scheme;` dans la configuration avancée de
NPM, sinon l'en-tête est réécrit en `http` et la connexion boucle indéfiniment.

### 9. Installer la PWA et vérifier

1. Ouvrir <https://cave.djkix.ovh/> : l'écran de connexion s'affiche.
2. « Se connecter avec Google » puis rentrer une bouteille avec une vraie photo
   d'étiquette : la fiche doit se pré-remplir en moins de dix secondes.
3. **Journal → Exporter le classeur** : la bouteille figure dans la feuille
   `Stock`.
4. Sur iPhone : *Partager → Sur l'écran d'accueil*. Sur Android : bannière
   d'installation.

## Mise à jour

Les images sont republiées automatiquement à chaque fusion sur `main`.

```bash
cd /opt/cave-a-vin && git pull && docker compose pull && docker compose up -d
```

Si les images sont construites localement, remplacer `docker compose pull` par
`docker compose build`. Pour figer une version plutôt que suivre `latest`,
fusionner la demande de version proposée par release-please puis renseigner
`IMAGE_TAG=<version>` dans le `.env`.

## Sauvegarde et restauration

`db-backup` dépose un `pg_dump` compressé chaque jour dans `BACKUP_DIR`
(rétention 30 jours par défaut). Le nom définitif n'apparaît qu'une fois le dump
**et** la compression réussis : un fichier `cave-*.sql.gz` est donc toujours
complet. Les dumps utilisent `--clean --if-exists`, ils se restaurent par-dessus
un schéma existant.

```bash
cd /opt/cave-a-vin && gunzip -c backups/cave-<date>.sql.gz | docker compose exec -T postgres psql -U cave -d cave
```

Les photos vivent dans le volume `photo_data` : à synchroniser vers le NAS chaque
semaine, elles ne sont pas couvertes par ce conteneur. Une sauvegarde jamais
restaurée n'étant pas une sauvegarde, prévoir un test de restauration
trimestriel.

## Développement

```bash
docker run -d --name cave-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=cave -p 5432:5432 postgres:16-alpine
```

```bash
docker run -d --name cave-redis -p 6379:6379 redis:7-alpine
```

```bash
cd api && npm ci && npx prisma migrate deploy && npm run seed && npm run start:dev
```

```bash
cd api && npm run start:worker:dev
```

```bash
cd web && npm ci && npm run dev
```

Tests : `cd api && npm test` (les suites qui touchent la base s'activent quand
`DATABASE_URL` est défini) et `cd web && npm test`.

Les deux index uniques partiels (`idx_movement_reverses_id`,
`idx_movement_photo_in`) ne sont pas exprimables dans le schéma Prisma : créer
les futures migrations avec `npx prisma migrate dev --create-only` et conserver
le SQL à la main, sinon Prisma proposera de les supprimer.

## Limites du lot 1

- **Référentiel des appellations** : 145 AOC sont chargées au démarrage (sur
  environ 360 reconnues par l'INAO). Une appellation absente du référentiel est
  conservée telle qu'elle a été lue ou saisie ; seule une correspondance quasi
  exacte (similarité ≥ 0,8) réécrit le libellé avec le nom canonique.
- **`GEMINI_MONTHLY_CAP_CENTS` est un plafond approximatif** : le coût par appel
  est une estimation à l'ordre de grandeur, pas une facturation réelle. Le
  réglage se comporte donc comme un nombre maximum de photos par mois.
- **Compte de secours** : `BREAK_GLASS_EMAIL` / `BREAK_GLASS_PASSWORD` vides =
  connexion Google uniquement.
- **Blocage de compte manuel** : il n'y a pas de modération automatique ; un
  administrateur doit bloquer un compte indésirable depuis `/admin`. Le blocage
  prend effet dès la requête suivante (la session en cours cesse de
  fonctionner), il n'attend pas une prochaine connexion.
- **Sortie de stock par photo, apogée et cote iDealwine** : lot 2.

## Journal des modifications

Le détail par version est dans [`CHANGELOG.md`](CHANGELOG.md) ; voici la version
courante.

### Non publié

**Fonctionnalités**

- Inscription libre : n'importe quel compte Google obtient un accès complet
  immédiat, sans liste blanche préalable.
- Espace d'administration (`/admin`) : liste des comptes, blocage/réactivation,
  promotion/retrait des droits d'administration ; désignation du ou des
  premiers administrateurs par `ADMIN_EMAILS`.

**Sécurité**

- La liste blanche `allowed_email` n'est plus le point de contrôle des accès ;
  le contrôle se fait désormais sur le statut du compte (`ACTIVE`/`BLOCKED`),
  et un blocage coupe la session en cours dès la requête suivante.

### 1.0.0 — 21 septembre 2026

**Fonctionnalités**

- Socle auto-hébergé : Compose (`web`, `api`, `worker`, `postgres`, `redis`,
  `db-backup`), connexion Google OpenID Connect avec liste blanche d'adresses,
  compte local de secours (argon2), sessions en Redis, PWA installable,
  intégration continue et publication automatique des images.
- Entrée de stock par photo : capture native, normalisation de l'image
  (redressement EXIF, JPEG 1600 px, métadonnées GPS supprimées), extraction par
  Gemini en JSON strict avec confiance par champ, recalage sur le référentiel des
  appellations, dédoublonnage des références, écran de confirmation éditable,
  quantité en un tap.
- Mode campagne : prise de vue en rafale puis revue groupée triée par confiance
  croissante, avec validation en masse.
- File hors ligne dans le navigateur (20 photos / 50 Mo) vidée au premier plan.
- Journal des 20 derniers mouvements avec annulation par mouvement inverse.
- Export Excel à la demande (`Stock`, `Mouvements`, `Référence`) avec filtre par
  couleur.

**Exploitation**

- Sauvegardes quotidiennes de la base avec rotation et fichiers jamais tronqués.
- Limitation de débit sur l'envoi de photos et sur la connexion locale.
- Plafond mensuel de dépense pour l'API de vision, au-delà duquel l'extraction
  est refusée et la saisie manuelle prend le relais.

**Corrections apportées à la première mise en service**

- Les moteurs Prisma sont désormais ceux compilés pour OpenSSL 3, faute de quoi
  l'api et le worker mouraient au démarrage sur `libssl.so.1.1: No such file`.
- L'en-tête `X-Forwarded-Proto` reçu de Nginx Proxy Manager est relayé tel quel :
  sans cela le cookie de session `Secure` n'était jamais posé et la connexion
  bouclait.
- Un `.env` dont les variables de compte de secours sont vides ne fait plus
  échouer le démarrage.

## Stack technique

NestJS (api + worker BullMQ), PostgreSQL 16 avec `pg_trgm`, Redis 7, React + Vite
en PWA, Gemini pour la lecture d'étiquettes, ExcelJS pour le classeur.

## Licence

MIT — voir [`LICENSE`](LICENSE).
