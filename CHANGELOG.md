# Journal des modifications

Toutes les modifications notables de Cave & Terroir sont consignées ici, la plus
récente en premier. Le projet suit le [versionnage sémantique](https://semver.org/lang/fr/).
Ce journal est repris dans le [README](README.md#journal-des-modifications) pour
la version courante.

Chaque version commence par un résumé rédigé, suivi du détail par commit généré
automatiquement par release-please à la publication. Les messages de commit des
tout premiers lots sont en anglais ; les suivants sont en français.

## Non publié

### Intégration continue

- **Publication des images fiabilisée** : la référence Git fait désormais partie
  du groupe de concurrence de la construction des images. Sans cela, la
  construction de l'image taguée d'une publication et celle de `latest` sur
  `main` se disputaient la même file d'attente — un seul travail peut y
  patienter, un troisième pousse celui en attente à l'annulation. C'est ce qui a
  laissé l'image `cave-a-vin-web:1.1.0` manquante à la publication de la 1.1.0
  (l'api, elle, était déjà publiée) ; elle a été republiée à la main.

## [1.1.0](https://github.com/djkix/cave-a-vin/compare/v1.0.0...v1.1.0) (2026-09-21)

### Résumé

Analyse des photos différée et jamais bloquante. En production, deux premiers
scans ont échoué sur un `503 Service Unavailable` de l'API Gemini (« This model
is currently experiencing high demand ») : le worker ne retentait que trois fois
en six secondes, les trois tentatives tombaient dans la même vague de
congestion, et la photo passait en échec définitif. L'image restait stockée sur
le volume Docker mais n'apparaissait plus nulle part, la revue groupée ne
listant que les analyses terminées.

### Fonctionnalités

- **Report au lieu de l'échec** : une indisponibilité passagère (429, 500, 502,
  503, 504, coupure réseau, plafond mensuel atteint) remet la photo en attente
  avec un motif lisible, au lieu de la marquer en échec.
- **Réessais patients** : délai exponentiel de 30 s à 15 minutes, sur environ
  1 000 tentatives, là où l'ancienne politique abandonnait au bout de six
  secondes.
- **Échec immédiat des erreurs définitives** : une sortie de modèle
  inexploitable ou une clé d'API invalide coupe la file tout de suite
  (`UnrecoverableError`) et propose la saisie manuelle, sans occuper la file
  pendant des jours.
- **Reprise au démarrage du worker** : les photos en attente dont le travail a
  disparu avec Redis sont remises en file. Un redémarrage de la pile ne laisse
  plus de photo stockée sans personne pour l'analyser.
- **Compteur d'attente** : bandeau « N photos en attente d'analyse » avec le
  motif du dernier report, sur l'accueil et dans la revue groupée.
- **Écran d'entrée unitaire non bloquant** : au bout de vingt secondes, ou dès
  que le worker signale un report, l'écran annonce « Analyse reportée », explique
  que la photo est enregistrée, et propose de partir ou de saisir à la main. Une
  coupure du flux d'événements affiche désormais ce report plutôt qu'un échec de
  lecture, puisque l'analyse continue côté serveur.
- **Version affichée en permanence** : en haut à droite de chaque écran et sur
  l'écran de connexion. `VITE_APP_VERSION` était déjà injectée dans l'image web
  par l'intégration continue, mais n'était affichée nulle part. Une image
  `latest` construite depuis `main` affiche désormais la version suivie de
  l'empreinte du commit (`1.0.0+ab12cd3`), pour ne pas faire passer des
  changements non publiés pour la dernière version publiée.

### Corrections

- Les photos déjà en échec pour une raison passagère sont remises en attente par
  la migration `20260925000000_photo_deferred_retry`, puis reprises
  automatiquement au démarrage suivant du worker : les deux bouteilles perdues
  lors de l'incident sont récupérées sans action manuelle.

### Détail par commit

### Fonctionnalités

* **analyse:** reporter l'analyse au lieu d'abandonner la photo ([b776bc3](https://github.com/djkix/cave-a-vin/commit/b776bc38b5e062169d8c7d0fecbb3012927d438e))
* **interface:** afficher la version sur chaque écran ([81d0bd8](https://github.com/djkix/cave-a-vin/commit/81d0bd8632871ffab9bd0ac5358985824e0faaef))


### Documentation

* une seule section 1.0.0, résumé rédigé puis détail par commit ([77e7ccc](https://github.com/djkix/cave-a-vin/commit/77e7ccc1fa9fe439379537a8b2f409cfff5f32b3))

## 1.0.0 (2026-09-21)

### Résumé

Première version déployable : lot 0 (socle) et lot 1 (entrée de stock par photo)
du cahier des charges, plus l'inscription libre et l'espace d'administration.

- **Socle auto-hébergé** : pile Docker Compose (`web`, `api`, `worker`,
  `postgres`, `redis`, `db-backup`), un seul port publié derrière Nginx Proxy
  Manager, secrets en `.env`, images publiées sur GHCR par l'intégration
  continue.
- **Comptes** : connexion Google OpenID Connect limitée aux scopes `openid`,
  `email` et `profile`, identité fondée sur le `sub` Google, sessions serveur en
  Redis (cookie `HttpOnly`, `Secure`, `SameSite=Lax`), compte local de secours à
  mot de passe argon2. L'inscription est libre : tout compte Google obtient un
  accès complet immédiat.
- **Administration** (`/admin`) : liste des comptes, blocage et réactivation,
  promotion et retrait des droits. `ADMIN_EMAILS` est un plancher garanti,
  jamais un plafond — une adresse qui y figure reste administratrice et ne peut
  être ni bloquée ni rétrogradée depuis l'interface (seul le `.env` le peut),
  tandis qu'une promotion accordée depuis l'interface à un compte absent de la
  variable est durable. Un administrateur ne peut pas modifier son propre compte.
- **Entrée de stock par photo** : capture par l'appareil photo natif,
  normalisation de l'image (redressement EXIF, JPEG qualité 85, largeur maximale
  1600 px, métadonnées GPS supprimées), extraction par Gemini en JSON strict avec
  un score de confiance par champ, recalage sur un référentiel de 145 AOC
  (recherche floue `pg_trgm`), dédoublonnage des références par clé de matching
  normalisée, écran de confirmation entièrement éditable, sélecteur de quantité
  1 · 6 · 12 · 18 avec présélection du nombre de cols lu sur le carton.
- **Mode campagne** : prise de vue en rafale sans confirmation unitaire, puis
  revue groupée des fiches extraites triées par confiance croissante, validation
  en masse et signalement des fiches incomplètes.
- **File hors ligne** : photos mises en attente dans le navigateur (20 photos ou
  50 Mo), envoi au retour au premier plan, au retour du réseau et toutes les
  minutes tant que l'application est ouverte ; compteur toujours visible.
- **Journal** : 20 derniers mouvements avec annulation en un tap, qui écrit un
  mouvement inverse plutôt que de supprimer quoi que ce soit.
- **Export Excel** : classeur `.xlsx` régénéré intégralement à la demande, trois
  feuilles (`Stock`, `Mouvements`, `Référence`), filtre optionnel par couleur.
- **PWA** : installable sur l'écran d'accueil iOS et Android, jeu de tokens de
  design « Cave & Terroir », aucune ressource `/api/` mise en cache par le
  service worker.

### Sécurité

- Le contrôle d'accès porte sur le statut du compte (`ACTIVE` / `BLOCKED`) et
  non plus sur une liste blanche d'adresses : la table `allowed_email` n'est plus
  lue par l'authentification (elle reste en base, sans suppression).
- Un blocage coupe la session en cours dès la requête suivante, et pas seulement
  à la prochaine connexion ; côté web, l'utilisateur est renvoyé sur l'écran de
  connexion au lieu de voir un faux message « serveur injoignable ».
- L'API d'administration n'expose jamais `passwordHash` (hachage argon2 du
  compte de secours) ni `googleSub` : la projection des champs est explicite.
- Limitation de débit sur l'envoi de photos (30/min) et sur la connexion locale
  (5/min).

### Intégrité des données

- Le stock est un journal en ajout seul : aucune colonne de quantité mutable, le
  stock est la somme des mouvements exposée par une vue matérialisée.
- Le stock ne peut jamais devenir négatif (contrainte vérifiée en base).
- Idempotence de bout en bout : empreinte de contenu par photo, clé
  d'idempotence par mouvement, un seul mouvement d'entrée par photo, et
  récupération propre en cas de soumission concurrente.
- Une annulation ne peut être faite qu'une fois, et une annulation n'est pas
  elle-même annulable.
- La sortie brute du modèle de vision est conservée telle quelle, pour pouvoir
  rejouer une extraction si le prompt évolue.

### Exploitation

- Sauvegardes quotidiennes `pg_dump --clean --if-exists` compressées avec
  rotation : le nom définitif n'apparaît qu'après un dump et une compression
  réussis, donc jamais de fichier tronqué.
- Plafond mensuel de dépense pour l'API de vision, au-delà duquel l'extraction
  est refusée et la saisie manuelle prend le relais.

### Corrections apportées lors de la première mise en service

- **Moteurs Prisma incompatibles** : `node:22-alpine` fournit OpenSSL 3, mais
  Prisma installait le moteur lié à OpenSSL 1.1 ; l'api et le worker mouraient au
  démarrage sur `libssl.so.1.1: No such file or directory`. Le bon `binaryTarget`
  est désormais déclaré et le build échoue immédiatement si les moteurs ne se
  chargent pas.
- **Cookie de session jamais posé derrière le proxy** : le nginx interne
  réécrivait `X-Forwarded-Proto` en `http`, ce qui faisait refuser le cookie
  `Secure` par la session et bouclait la connexion. L'en-tête reçu de Nginx Proxy
  Manager est maintenant relayé tel quel.
- **Démarrage impossible avec un `.env` d'exemple** : les variables de compte de
  secours vides faisaient échouer la validation d'environnement.
- **Tests verts en local et rouges en intégration continue** : `ADMIN_EMAILS`
  était lu depuis l'environnement mémoïsé, la valeur du job écrasait donc celle
  des tests ; et le test du générateur de tokens était appelé par répertoire, ce
  que Node 22 ne sait pas faire.

### Détail par commit

### Fonctionnalités

* **admin:** espace d'administration des comptes ([0a9a5d5](https://github.com/djkix/cave-a-vin/commit/0a9a5d5c45e790fe8ee8bdce112075e71c8d1706))
* **appellations:** INAO referential seed and pg_trgm fuzzy resolution ([af6124c](https://github.com/djkix/cave-a-vin/commit/af6124c5737f83799e525cdf45bf3358a4a8ff70))
* **auth:** Google OIDC with e-mail whitelist, Redis sessions and argon2 break-glass login ([232a912](https://github.com/djkix/cave-a-vin/commit/232a91212eb9cc8c6389af0dc88969f6710484fe))
* **auth:** inscription libre, accès immédiat, blocage de compte ([cd38a07](https://github.com/djkix/cave-a-vin/commit/cd38a07aeb0f7cc2648ba38d07422696a8c61637))
* **db:** Prisma schema, pg_trgm, no-negative-stock trigger and stock_courant view ([096afef](https://github.com/djkix/cave-a-vin/commit/096afef85e25d3ea02af8bf5e2d0fb363d025217))
* **export:** on-demand Excel workbook (Stock, Mouvements, Référence) ([4526c09](https://github.com/djkix/cave-a-vin/commit/4526c093ea6690b126fceddac78166ee3233b5bf))
* **movements:** confirmed IN movements with idempotency, inverse-movement cancel and history ([8289f12](https://github.com/djkix/cave-a-vin/commit/8289f123ab5288729d957c33b0d3e107691d9ff0))
* **ops:** Docker Compose stack, Dockerfiles, backup sidecar and env template ([2f9e20b](https://github.com/djkix/cave-a-vin/commit/2f9e20b5b3f100dca652bc83ead40caff6bc5d40))
* **photos:** upload, sharp normalization, content-hash dedup and local storage ([abfb8cf](https://github.com/djkix/cave-a-vin/commit/abfb8cf698a20b6d755ff19d7c5fc7ed10016739))
* **queue:** BullMQ extraction worker with monthly vision cap and SSE result stream ([5e4b3f5](https://github.com/djkix/cave-a-vin/commit/5e4b3f55a6fbab00977e0133a9e66dfbe6ba5502))
* **vision:** VisionProvider contract, strict JSON schema and Gemini implementation ([9276977](https://github.com/djkix/cave-a-vin/commit/927697786624a0eefb53f13729126d4ae83a69ce))
* **web:** campaign mode with burst capture and grouped review ([4292311](https://github.com/djkix/cave-a-vin/commit/4292311aaa1795490101fa1718c59a969835a07c))
* **web:** Cave & Terroir design tokens, base styles and confirmation-screen components ([3a8182e](https://github.com/djkix/cave-a-vin/commit/3a8182ef03bfca84ec6c48ce0c6186ffc6454e11))
* **web:** IndexedDB offline photo queue with foreground flush and visible counter ([80787ca](https://github.com/djkix/cave-a-vin/commit/80787ca97baa4d2488ee3d457b4cd03154a7ddb8))
* **web:** installable PWA shell with login, gated home and bottom navigation ([585c7ea](https://github.com/djkix/cave-a-vin/commit/585c7ea91f0d8bfdc6c26ae8ae8c18cf09c04cb0))
* **web:** journal with one-tap cancel and Excel export button ([3126612](https://github.com/djkix/cave-a-vin/commit/31266127522960624918c81f10742acf07c85b7b))
* **web:** photo capture, live extraction wait and confirmed stock-entry screen ([259b549](https://github.com/djkix/cave-a-vin/commit/259b5493d406fa96a2d39fea0140bf64840d66f2))
* **wines:** normalized match key and dedup against the appellation referential ([ed308cd](https://github.com/djkix/cave-a-vin/commit/ed308cd2be8a7a4dc4848ff8e13c140d7db5cc3e))


### Corrections

* **admin:** ne jamais exposer passwordHash/googleSub, ADMIN_EMAILS plancher ([04d449c](https://github.com/djkix/cave-a-vin/commit/04d449ca718e8bf93980951915508f68582faa4b))
* **api:** boot with an empty .env, rate-limit the costly routes, one IN per photo ([4c596f3](https://github.com/djkix/cave-a-vin/commit/4c596f386e73904809dd40382f3e52e195b28a44))
* **auth:** link Google sub to an existing local account, propagate logout errors, log Redis errors ([7f22482](https://github.com/djkix/cave-a-vin/commit/7f2248208e3188c7dfc38e18f0b512fb25362a97))
* **auth:** lire ADMIN_EMAILS à l'appel, pas depuis le cache d'environnement ([e1e506b](https://github.com/djkix/cave-a-vin/commit/e1e506b024f73256ca8a2098c7a2e229bfaffeb5))
* **auth:** rediriger un compte bloqué en session ouverte, aligner local-login ([938d99b](https://github.com/djkix/cave-a-vin/commit/938d99bc8f258c7ec8d0f842d6a4271b3c067a1a))
* **ci:** least-privilege permissions for the release job ([2da50c7](https://github.com/djkix/cave-a-vin/commit/2da50c771cf4e5ff9f5381387e1dc4ceb5c8f138))
* **ci:** run the token-generator test by file path ([a140da1](https://github.com/djkix/cave-a-vin/commit/a140da11b23f1992ff67bf47941f3d985ef88f42))
* **deploy:** preserve the upstream X-Forwarded-Proto and never publish a truncated dump ([538243a](https://github.com/djkix/cave-a-vin/commit/538243a42cb020342e9bf1bbd741fe9a4dde4450))
* **docker:** charger les moteurs Prisma compilés pour OpenSSL 3 ([2fa5c50](https://github.com/djkix/cave-a-vin/commit/2fa5c5088a55d081b2c408fc3c13fe1792912f02))
* **export:** auto-filter on the Référence sheet, purchase price from IN movements only ([0892d63](https://github.com/djkix/cave-a-vin/commit/0892d630ba022b3994c7477a9af4b75d7f173291))
* **movements:** make replays and cancels safe under concurrency, validate the cancel body ([3048aad](https://github.com/djkix/cave-a-vin/commit/3048aadeb445d5bd23d498996db449a192e6dde3))
* **photos:** recover from concurrent duplicate uploads, reject unreadable images with a 400, drop HEIC ([a04488e](https://github.com/djkix/cave-a-vin/commit/a04488e4082833f3cdecd628a4374f7aa242d612))
* **queue:** keep the api alive on SSE errors, fail only on the last attempt, roll back photos the queue cannot accept ([fde0026](https://github.com/djkix/cave-a-vin/commit/fde0026a21c6865fcc4987ea650e5f9034a23ab7))
* **web:** campaign review surfaces bulk errors and incomplete rows; drop dead camera re-open; tolerate unparseable extractions ([f18f781](https://github.com/djkix/cave-a-vin/commit/f18f781eb1d640fdafe29fe520147b778f4040ad))
* **web:** controlled EditableField, blur-committed free quantity, spacing token in QuantityPicker ([7f23421](https://github.com/djkix/cave-a-vin/commit/7f23421f553c7db38fc0216b096ce8a5f84a7bb9))
* **web:** keep retryable uploads, explain a refused login, never leave a dead screen ([e48fb9a](https://github.com/djkix/cave-a-vin/commit/e48fb9a862eebf03787d3706c888d5ff7cce1cc3))
* **web:** never-cache /api/ in the service worker and preserve JSON Content-Type with custom headers ([b3c36bb](https://github.com/djkix/cave-a-vin/commit/b3c36bb52612b5b38da1866ce023792ffacef00a))
* **web:** resilient confirmation page (fetch errors, DONE prefill, no SSE leak, single submit); validate photo id on the image route ([b48414d](https://github.com/djkix/cave-a-vin/commit/b48414d25a202f47a6f9a5e305c9b10b491ffd9c))
* **web:** stable foreground flush triggers, skip deterministically rejected photos, test the queue hook and capture page ([6fbac09](https://github.com/djkix/cave-a-vin/commit/6fbac098643b267879e9066ce3bdc34e50405658))
* **wines:** resolve concurrent-create races and stop merging producers on connector words ([fd02764](https://github.com/djkix/cave-a-vin/commit/fd0276461e0660db7eedd0f7044872ec75ba4cf8))


### Documentation

* cahier des charges et spec de design Lot 0+1 ([fc5dad5](https://github.com/djkix/cave-a-vin/commit/fc5dad5febda80387da693f70c2bde8db11d49e4))
* document the lot 1 limits, the break-glass account and the restore ([4060fea](https://github.com/djkix/cave-a-vin/commit/4060fea7ea31405cea7403ba2b7747c36d6d42e4))
* inscription libre et espace d'administration ([8f53626](https://github.com/djkix/cave-a-vin/commit/8f53626d66e2a0dee9e47fccc42fe1fbd7c8e200))
* plan d'implémentation Lot 0+1 (18 tâches) ([047c009](https://github.com/djkix/cave-a-vin/commit/047c0096d5e837fbfbf8364249462703f9b1c090))
* README détaillé, changelog en français et domaine réel ([f3335cf](https://github.com/djkix/cave-a-vin/commit/f3335cfbdde1da7787fc48e867005d8872d44135))
* sémantique plancher d'ADMIN_EMAILS et correctifs de revue ([ac49d71](https://github.com/djkix/cave-a-vin/commit/ac49d71210f2381fe302abaf78beaed2e323e793))


### Tests

* **api:** HTTP smoke spec over the real AppModule ([24f5230](https://github.com/djkix/cave-a-vin/commit/24f5230939258d3f2ec4881503ea166fd1237682))


### Intégration continue

* **api:** type-check, build and run the HTTP spec against Postgres and Redis ([cd20929](https://github.com/djkix/cave-a-vin/commit/cd20929d3c707912d472028cf39829bd18a92a58))
* lint/test pipeline, GHCR image publishing and release-please ([1b88a93](https://github.com/djkix/cave-a-vin/commit/1b88a938f4699ef8e65300cc1bb1177acf9f4982))


### Divers

* ignore SDD workspace ([88c65b7](https://github.com/djkix/cave-a-vin/commit/88c65b7ce71658f2412bcb7a4c403309cb4c1e62))
* scaffold api (NestJS) and web (Vite PWA) skeletons with smoke tests ([bef36bf](https://github.com/djkix/cave-a-vin/commit/bef36bfb3e2795ea36da0789c409bb9d8ba8d28b))
