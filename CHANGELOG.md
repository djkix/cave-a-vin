# Journal des modifications

Toutes les modifications notables de Cave & Terroir sont consignées ici, la plus
récente en premier. Le projet suit le [versionnage sémantique](https://semver.org/lang/fr/).
Ce journal est repris dans le [README](README.md#journal-des-modifications) pour
la version courante.

## Non publié

### Fonctionnalités

- Inscription libre : n'importe quel compte Google obtient désormais un accès
  complet immédiat, sans liste blanche préalable.
- Espace d'administration (`/admin`) : liste des comptes, blocage/réactivation,
  promotion/retrait des droits d'administration ; désignation du ou des
  premiers administrateurs par la variable `ADMIN_EMAILS`.

### Sécurité

- La liste blanche `allowed_email` n'est plus le point de contrôle des accès :
  elle n'est plus lue par l'authentification (la table reste en base, sans
  suppression). Le contrôle se fait désormais sur le statut du compte
  (`ACTIVE`/`BLOCKED`) ; un blocage coupe la session en cours dès la requête
  suivante, pas seulement la prochaine connexion.

## 1.0.0 — 21 septembre 2026

Première version déployable : lot 0 (socle) et lot 1 (entrée de stock par photo)
du cahier des charges.

### Fonctionnalités

- **Socle auto-hébergé** : pile Docker Compose (`web`, `api`, `worker`,
  `postgres`, `redis`, `db-backup`), un seul port publié derrière Nginx Proxy
  Manager, secrets en `.env`, images publiées sur GHCR par l'intégration
  continue.
- **Authentification** : connexion Google OpenID Connect limitée aux scopes
  `openid`, `email` et `profile`, liste blanche d'adresses en base, identité
  fondée sur le `sub` Google, sessions serveur en Redis (cookie `HttpOnly`,
  `Secure`, `SameSite=Lax`), compte local de secours à mot de passe argon2.
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
- Limitation de débit sur l'envoi de photos (30/min) et sur la connexion locale
  (5/min).
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
- **Test du générateur de tokens en intégration continue** : appelé par chemin de
  fichier, la découverte par répertoire n'existant pas sur Node 22.
