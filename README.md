# Cave & Terroir

Gestion de cave à vin sans saisie clavier : une photo à l'achat crédite le stock,
une photo au moment de boire le débite, et un classeur Excel exportable donne à
tout moment l'état complet de la cave. Application auto-hébergée en Docker,
utilisée depuis un téléphone (PWA installable).

- **URL publique** : <https://cave.djkix.ovh/>
- **État** : lot 0, lot 1, lot 2a, lot 2b et lot 3a livrés — socle, entrée de
  stock par photo (Gemini), mode campagne, file hors ligne, journal et export
  Excel, onglet Cave, fiche vin et sortie de stock (par la liste ou par photo),
  estimation de l'apogée par règles avec correction manuelle par vin, filtre
  « à boire en priorité ».
- **Reportés, en lots séparés** : emplacements dans la cave, cote iDealwine
  (lot 2c). Pas d'alerte hors de l'application (notification ou e-mail) : la
  liste « à boire en priorité » se consulte dans l'application. Voir
  `cahier-des-charges.md`.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Architecture et ports](#architecture-et-ports)
- [Déploiement](#déploiement)
- [Mise à jour](#mise-à-jour)
- [Sauvegarde et restauration](#sauvegarde-et-restauration)
- [Développement](#développement)
- [Limites](#limites)
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

**La cave et la sortie.** L'onglet *Cave* liste les vins en stock avec
vignette (photo de l'entrée, ou un pictogramme de bouteille s'il n'y a pas de
photo ou qu'elle ne charge pas), domaine, cuvée, appellation, millésime,
couleur et quantité ; la recherche porte sur domaine/cuvée/appellation sans
tenir compte des accents ni de la casse (« chateauneuf » trouve
« Châteauneuf-du-Pape »), un filtre par couleur s'ajoute, et les vins épuisés
restent masqués sauf à cocher « Vins épuisés ». La fiche vin affiche la photo
de référence (celle de la première entrée), le stock et les 10 derniers
mouvements ; *Sortir* propose un sélecteur de quantité borné par le stock puis
confirme « Sorti — il en reste N » (le message survit au rafraîchissement du
stock, y compris pour la dernière bouteille) ; *Corriger le stock* permet un
inventaire physique — le nombre compté, l'écart annoncé avant d'enregistrer
(« −2 bouteilles », « Stock déjà juste »), écrit comme un mouvement `ADJUST`
daté (« Inventaire : N comptées »). La **sortie par photo** (bouton *Sortir une
bouteille* sur l'accueil, ou onglet *Sortie*) ne reconnaît que les vins en
stock : l'étiquette est lue par Gemini puis comparée sur domaine/cuvée/
appellation, le millésime pesant fortement. Un candidat clair déclenche une
confirmation ; plusieurs candidats (ou un candidat incertain) affichent 1 à 4
vignettes avec le millésime en gros, un tap suffit pour choisir, et « Choisir
un autre millésime » permet de revenir en arrière ; aucun candidat affiche
« Ce vin n'est pas dans la cave » avec « Chercher dans la cave » (recherche
pré-remplie avec ce qui a été lu) ou « Rentrer ce vin ». Si l'envoi de la photo
échoue, « Réessayer l'envoi » renvoie la même photo sans reprendre une capture ;
si l'analyse échoue d'emblée ou n'a pas abouti au bout de 12 s, l'écran bascule
sur « Chercher dans la cave ». Rien n'est jamais sorti sans confirmation
explicite. Les photos de sortie ne sont **jamais reportées** : deux tentatives
à 3 s d'intervalle puis abandon (l'utilisateur sort par la liste) ; elles
n'apparaissent ni dans la revue groupée ni dans le bandeau « en attente
d'analyse », et ne sont pas remises en file au démarrage du worker.

**Analyse différée, jamais bloquante.** L'analyse ne dépend pas de la
disponibilité de l'API de vision. Dès qu'une photo est reçue, elle est stockée
sur le serveur ; si le service de lecture est saturé, injoignable ou à quota
(erreurs 429, 500, 502, 503, 504, coupure réseau, plafond mensuel atteint), la
photo **retourne en attente au lieu d'échouer** et le worker la reprend
automatiquement — 30 s, 1 min, 2, 4, 8, puis toutes les 15 minutes, pendant une
dizaine de jours si nécessaire. Un bandeau « N photos en attente d'analyse »,
avec le motif du dernier report, reste visible sur l'accueil et dans la revue
groupée. L'écran d'entrée unitaire n'attend jamais plus de vingt secondes : il
annonce le report et propose de partir ou de saisir la fiche à la main. À
l'inverse, une erreur dont un réessai ne changera rien (étiquette inexploitable,
clé d'API invalide) échoue immédiatement et propose la saisie manuelle, sans
occuper la file. Au démarrage, le worker remet en file les photos en attente que
Redis aurait oubliées : une photo reçue n'est jamais perdue, même après un
redémarrage de la pile.

**Version affichée en permanence.** Le numéro de version est visible en haut à
droite de chaque écran, et sur l'écran de connexion avant même de s'identifier —
indispensable dans une PWA installée, où aucune barre d'adresse ne dit ce qui
tourne. Une image publiée affiche son numéro (`1.0.0`) ; une image `latest`
construite depuis `main` affiche ce numéro suivi de l'empreinte du commit
(`1.0.0+ab12cd3`), pour ne jamais faire passer des changements non publiés pour
la dernière version ; une construction locale affiche `dev`.

**Hors ligne.** La cave est souvent un sous-sol sans réseau : les photos sont
mises en file dans le navigateur (20 photos ou 50 Mo maximum) et envoyées dès que
l'application est rouverte avec du réseau. Un compteur « N photos en attente »
reste visible.

**Journal et annulation.** Les 20 derniers mouvements sont consultables et
annulables en un tap. Une annulation écrit un mouvement inverse : rien n'est
jamais supprimé, l'historique reste vrai.

**Apogée.** Une fourchette de buvabilité est estimée par règles pour chaque vin
millésimé, **recalculée à la lecture** (jamais stockée, donc jamais périmée) :
`[millésime + garde min × f ; millésime + garde max × f]`, où la garde vient,
par ordre de priorité, d'un ajustement pour l'appellation et la couleur, du cas
particulier des rosés (1 à 3 ans), d'un ajustement pour l'appellation entière,
ou de la garde du référentiel ; le facteur `f` vaut 1,2 pour un grand
millésime, 0,85 pour un millésime faible et **1,0 par défaut** (millésime
« moyen », tant qu'il n'a pas été qualifié). La fiche vin affiche la fourchette,
un badge de confiance (*Saisie* en cas de correction manuelle, *Confiance
moyenne* si le millésime est qualifié, *Confiance faible* sinon) et un statut
(« Trop jeune », « À boire », « À boire vite », « Apogée passée depuis… ») ;
quand aucune estimation n'est possible (vin non millésimé, appellation non
reconnue, garde inconnue), la raison s'affiche avec une saisie manuelle
proposée. *Corriger* permet à tout compte actif de fixer deux années, qui
priment alors toujours sur les règles ; *Revenir à l'estimation* efface la
correction. L'onglet *Cave* porte une mention courte par ligne (« À boire
2024-2036 », « Trop jeune (2027) », « À boire vite », « Apogée passée »).
Réservée aux administrateurs, l'**administration des règles** (espace
Administration) permet de qualifier le millésime d'une région (grand / moyen /
faible) et d'ajuster la garde d'une appellation (pour toutes les couleurs ou
une seule) ; les changements s'appliquent immédiatement partout, sur toutes
les fiches concernées.

**À boire en priorité.** Dans l'onglet *Cave*, la case *À boire en priorité*
ne garde que les vins dont l'apogée se termine **au plus tard l'an prochain**
(apogée passée, dernière année, ou fin l'an prochain — l'année de marge laisse
le temps de prévoir l'occasion), la fin la plus proche en premier, puis par
producteur. Une correction manuelle de l'apogée compte comme l'estimation. Les
vins sans estimation n'y figurent jamais, mais ne sont pas oubliés : un bandeau
« N vins sans apogée estimée » mène, par *À compléter*, à la case *Sans
apogée*, qui les liste pour qu'on saisisse leur fourchette depuis la fiche. Les
deux cases s'excluent ; elles se combinent avec la recherche, la couleur et les
vins épuisés. Côté API : `GET /api/cave?drinkSoon=true` et
`GET /api/cave?noApogee=true`.

**Export Excel.** Un classeur `.xlsx` à la demande, régénéré intégralement à
chaque fois, avec trois feuilles (`Stock`, `Mouvements`, `Référence`), un filtre
optionnel par couleur et la case *Seulement les vins à boire en priorité*
(même règle et même ordre que l'onglet Cave ; `GET /api/export.xlsx?drinkSoon=true`). La feuille `Stock` ajoute *Apogée min*, *Apogée max* et
*Confiance* après *Millésime* ; une ligne dont l'apogée est déjà passée est
mise en évidence par une teinte d'alerte.

**Garde-fous.** Stock jamais négatif (contrainte en base), **même sous
concurrence** : le déclencheur verrouille désormais la ligne du vin avant de
vérifier le stock, pour qu'une sortie simultanée des dernières bouteilles ne
puisse pas en laisser passer deux à la fois. Le stock affiché est **calculé à
chaque lecture** à partir du journal (vue `stock_courant`) : deux mouvements
simultanés ne peuvent plus en faire disparaître un. Journal en ajout seul,
idempotence de bout en bout (empreinte de contenu par photo, clé d'idempotence par
mouvement, un seul mouvement d'entrée par photo **et une seule sortie par
photo**, une clé d'idempotence déjà utilisée par un autre mouvement est
refusée plutôt que rejouée comme une sortie), inventaire physique sous verrou
de ligne (deux inventaires simultanés n'écrivent l'écart qu'une fois), et
plafond mensuel de dépense pour l'API de vision.

**Comptes et administration.** L'inscription est libre : n'importe quel compte
Google se connecte et a immédiatement accès complet à l'application. Le
propriétaire désigne un ou plusieurs administrateurs via `ADMIN_EMAILS`, et
bloque ensuite les comptes indésirables depuis l'espace `/admin` (liste des
comptes, blocage/réactivation, promotion/retrait des droits d'administration).
`ADMIN_EMAILS` est un **plancher garanti, jamais un plafond** : une adresse qui
y figure est administratrice même si la base dit le contraire (le propriétaire
ne peut jamais s'enfermer dehors), et ces comptes-là ne sont ni blocables ni
rétrogradables depuis `/admin` — seul le `.env` le peut. À l'inverse, une
promotion accordée depuis l'interface à un compte absent d'`ADMIN_EMAILS` est
durable : elle survit aux connexions suivantes, jamais écrasée par
l'environnement. Un administrateur ne peut pas non plus modifier son propre
compte, pour ne jamais perdre l'accès à l'administration par erreur. Un
blocage prend effet dès la requête suivante, y compris sur une session déjà
ouverte : il n'attend pas une prochaine connexion.

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

### 2. Créer la stack

La stack est **autonome** : le `docker-compose.yml` et son `.env` suffisent,
aucun autre fichier du dépôt n'est nécessaire sur l'hôte (les images portent le
code, et le script de sauvegarde est écrit dans le YAML lui-même). L'intégration
continue le vérifie à chaque commit en démarrant la stack dans un dossier qui ne
contient que ces deux fichiers.

**Avec Dockge** (le cas de ce serveur) : créer une stack `cave-a-vin`, coller le
contenu de [`docker-compose.yml`](docker-compose.yml) dans l'éditeur et celui du
`.env` (étape 4) dans le panneau des variables. Dockge range la stack dans
`/opt/stacks/cave-a-vin/`.

**En ligne de commande**, l'équivalent :

```bash
mkdir -p /opt/stacks/cave-a-vin && cd /opt/stacks/cave-a-vin
curl -fsSLO https://raw.githubusercontent.com/djkix/cave-a-vin/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/djkix/cave-a-vin/main/.env.example
```

Les sauvegardes sont écrites dans `./backups`, à côté du YAML.

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
cd /opt/stacks/cave-a-vin && nano .env
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
cd /opt/stacks/cave-a-vin && docker compose pull
```

… soit construire les images sur place, ce qui évite toute authentification.
C'est le seul cas où le dépôt complet est nécessaire sur l'hôte, puisque la
construction part des sources :

```bash
git clone https://github.com/djkix/cave-a-vin.git /opt/stacks/cave-a-vin-src
cd /opt/stacks/cave-a-vin-src && docker compose build
```

### 6. Démarrer

```bash
cd /opt/stacks/cave-a-vin && docker compose up -d
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
C'est un plancher garanti, pas un plafond : un compte listé ici reste
administrateur quoi qu'il arrive et **ne peut pas être bloqué ni rétrogradé
depuis `/admin`** (l'interface refuse l'action) — seule une modification de ce
fichier le peut. À l'inverse, promouvoir depuis `/admin` un compte qui n'est
pas dans `ADMIN_EMAILS` reste valable durablement, connexion après connexion.

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
cd /opt/stacks/cave-a-vin && docker compose pull && docker compose up -d
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

Pour vérifier que la sauvegarde tourne vraiment — le conteneur annonce son
réglage au démarrage puis chaque dump écrit :

```bash
cd /opt/stacks/cave-a-vin && docker compose logs db-backup --tail=5 && ls -la backups/
```

Restauration :

```bash
cd /opt/stacks/cave-a-vin && gunzip -c backups/cave-<date>.sql.gz | docker compose exec -T postgres psql -U cave -d cave
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

Les index uniques partiels (`idx_movement_reverses_id`,
`idx_movement_photo_in`, `idx_movement_photo_out`, `idx_guard_override_all_colors`,
`idx_guard_override_color`) et la fonction de déclencheur
`check_stock_non_negative` ne sont pas exprimables dans le schéma Prisma :
créer les futures migrations avec `npx prisma migrate dev --create-only` et
conserver ce SQL écrit à la main, sinon Prisma proposera de le supprimer.

## Limites

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
- **Réessai borné dans le temps** : une photo reportée est reprise pendant
  environ dix jours (1 000 tentatives au plafond de 15 minutes). Au-delà, elle
  passe en échec et attend une saisie manuelle — un travail qui ne meurt jamais
  finirait par masquer une panne réelle.
- **Pas de relance manuelle d'une analyse** : il n'y a pas de bouton
  « réanalyser » sur une photo en échec définitif ; la saisie manuelle prend le
  relais, et reprendre la photo crée simplement une nouvelle entrée.
- **La reconnaissance ne départage pas seule deux millésimes** quand l'année
  n'est pas lisible sur l'étiquette : la sortie par photo propose alors le
  choix sur vignettes plutôt que de deviner.
- **Qualité des millésimes non pré-remplie** : tant qu'une région n'a pas été
  qualifiée depuis l'administration, tous ses millésimes comptent pour
  « moyen » (facteur 1,0).
- **Pas d'estimation d'apogée pour les vins non millésimés** : la fiche
  l'indique et ne propose que la saisie manuelle.
- **Pas d'alerte hors de l'application** : la liste « à boire en priorité » se
  consulte, elle ne prévient pas (choix assumé). **Emplacements dans la cave**
  et **cote iDealwine** : reportés, chacun dans un lot séparé.
- **Après « Annuler »**, le panneau de sortie de la fiche vin reste sur
  « Sortie annulée » jusqu'à ce qu'on quitte la page (pas de retour
  automatique à l'écran de sortie).

## Journal des modifications

Le détail par version, avec le lien vers chaque commit, est dans
[`CHANGELOG.md`](CHANGELOG.md) ; voici les versions publiées.

### 1.4.0 — 5 octobre 2026

Publiée ([v1.4.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.4.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.4.0` et `-web:1.4.0`.

**À boire en priorité.** Dans l'onglet Cave, la case *À boire en priorité*
garde les vins dont l'apogée se termine au plus tard l'an prochain, la fin la
plus proche en premier ; la case *Sans apogée* liste les vins sans estimation,
signalés par un bandeau « N vins sans apogée estimée — À compléter ». L'export
Excel propose *Seulement les vins à boire en priorité*. Ni migration ni
nouvelle variable d'environnement.

### 1.3.0 — 4 octobre 2026

Publiée ([v1.3.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.3.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.3.0` et `-web:1.3.0`.

**L'apogée : une fourchette de buvabilité estimée par règles, recalculée à
chaque lecture.** Fiche vin (fourchette, confiance, statut, correction
manuelle par vin qui prime toujours), mention courte dans l'onglet Cave,
colonnes *Apogée min*, *Apogée max* et *Confiance* dans l'export Excel (apogées
passées mises en évidence), administration réservée aux administrateurs pour
qualifier le millésime d'une région et ajuster la garde d'une appellation
(l'écran rappelle que les rosés se gardent 1 à 3 ans sauf ajustement « Rosé »,
qu'un ajustement « Toutes couleurs » ne s'applique pas à eux).
Migration `20261005000000_lot2b_apogee` (tables `vintage_quality`,
`guard_override`).

### 1.2.0 — 4 octobre 2026

Publiée ([v1.2.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.2.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.2.0` et `-web:1.2.0`.

**Le lot 2a boucle le cycle du stock : on peut désormais sortir ce qu'on a
rentré.** Onglet *Cave* (recherche sans accents, filtre couleur, vins
épuisés) ; fiche vin (photo de référence, stock, derniers mouvements, sortie
par quantité, inventaire physique avec écart annoncé) ; sortie par photo
restreinte aux vins en stock, avec choix sur vignettes quand plusieurs
millésimes sont proches et repli sur la cave en cas d'échec ou au bout de
12 s ; photos de sortie jamais reportées. Correction : le déclencheur « stock
jamais négatif » verrouille désormais la ligne du vin, deux sorties
simultanées de la dernière bouteille ne passent plus toutes les deux. Une
photo de sortie réutilisée après une annulation sort bien le vin choisi
ensuite ; réutilisée pour un autre vin sans annulation, elle est refusée en
clair. Une sortie rejouée par le serveur s'annonce « Déjà sortie — il en reste
N ». Le résultat et *Annuler* restent affichés après la sortie de la dernière
bouteille, même au retour sur l'application. Les vignettes de choix affichent
le format (« 150 cl »), et l'inventaire refuse un compte au-delà de 100 000
bouteilles. Une photo d'entrée identique à une ancienne photo de sortie
inutilisée rejoint la revue groupée.

### 1.1.2 — 3 octobre 2026

Version de documentation uniquement ([v1.1.2](https://github.com/djkix/cave-a-vin/releases/tag/v1.1.2)),
sans changement de code. Désormais, seuls les commits de fonctionnalité, de
correction et de performance déclenchent une nouvelle version : la mise à jour
de la documentation n'ouvre plus de version vide.

### 1.1.1 — 3 octobre 2026

Publiée ([v1.1.1](https://github.com/djkix/cave-a-vin/releases/tag/v1.1.1)),
images `ghcr.io/djkix/cave-a-vin-api:1.1.1` et `-web:1.1.1`.

**La sauvegarde de la base tourne enfin.** Le service `db-backup` dépendait d'un
script du dépôt monté depuis l'hôte, absent d'une stack créée dans Dockge : il
redémarrait en boucle sans jamais produire de dump. Le script est désormais écrit
dans le `docker-compose.yml`, la stack est autonome, et l'intégration continue
le vérifie à chaque commit en exigeant un vrai dump. La documentation de
déploiement décrit maintenant la création par Dockge. La construction des images
d'une publication ne peut plus être annulée par un push concurrent.

### 1.1.0 — 21 septembre 2026

Publiée ([v1.1.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.1.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.1.0` et `-web:1.1.0`.

**Analyse des photos différée et jamais bloquante.** Une indisponibilité
passagère du service de vision (429, 500, 502, 503, 504, coupure réseau,
plafond mensuel atteint) remet la photo en attente au lieu de la marquer en
échec, et le worker la reprend de 30 s à 15 minutes d'intervalle pendant une
dizaine de jours. Les erreurs définitives, elles, échouent immédiatement et
proposent la saisie manuelle. Le worker remet en file au démarrage les photos
que Redis a oubliées, un bandeau compte les photos en attente avec le motif du
dernier report, et l'écran d'entrée unitaire n'attend plus indéfiniment. La
migration `20260925000000_photo_deferred_retry` récupère les photos déjà
abandonnées à tort.

**Version affichée en permanence** en haut à droite de chaque écran et sur
l'écran de connexion, avec l'empreinte du commit pour une image `latest`.

### 1.0.0 — 21 septembre 2026

Première version déployable ([v1.0.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.0.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.0.0` et `-web:1.0.0`.

**Fonctionnalités**

- Socle auto-hébergé : Compose (`web`, `api`, `worker`, `postgres`, `redis`,
  `db-backup`), un seul port publié derrière Nginx Proxy Manager, intégration
  continue et publication automatique des images.
- Comptes : connexion Google OpenID Connect (scopes `openid`, `email`,
  `profile`), inscription libre avec accès complet immédiat, compte local de
  secours, sessions serveur en Redis.
- Administration (`/admin`) : blocage et réactivation des comptes, promotion et
  retrait des droits, avec `ADMIN_EMAILS` comme plancher garanti.
- Entrée de stock par photo : capture native, normalisation de l'image,
  extraction par Gemini avec confiance par champ, recalage sur le référentiel des
  appellations, dédoublonnage, écran de confirmation éditable, quantité en un tap.
- Mode campagne : rafale puis revue groupée triée par confiance croissante.
- File hors ligne (20 photos / 50 Mo) vidée au premier plan.
- Journal des 20 derniers mouvements avec annulation par mouvement inverse.
- Export Excel à la demande (`Stock`, `Mouvements`, `Référence`) avec filtre par
  couleur.

**Sécurité et exploitation**

- Contrôle d'accès par statut de compte : un blocage coupe la session en cours
  dès la requête suivante.
- L'API d'administration n'expose ni hachage de mot de passe ni identifiant
  Google.
- Sauvegardes quotidiennes de la base avec rotation, sans fichier tronqué.
- Limitation de débit sur l'envoi de photos et sur la connexion locale.
- Plafond mensuel de dépense pour l'API de vision.

**Corrections de la première mise en service**

- Moteurs Prisma compilés pour OpenSSL 3 (l'api et le worker ne démarraient pas).
- En-tête `X-Forwarded-Proto` relayé tel quel (le cookie de session n'était
  jamais posé derrière le proxy et la connexion bouclait).
- Démarrage possible avec un `.env` dont les variables de secours sont vides.

## Stack technique

NestJS (api + worker BullMQ), PostgreSQL 16 avec `pg_trgm`, Redis 7, React + Vite
en PWA, Gemini pour la lecture d'étiquettes, ExcelJS pour le classeur.

## Licence

MIT — voir [`LICENSE`](LICENSE).
