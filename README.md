# Cave & Terroir

Gestion de cave à vin sans saisie clavier : une photo à l'achat crédite le stock,
une photo au moment de boire le débite, un classeur Excel exportable donne l'état
complet de la cave. Auto-hébergé en Docker, utilisé depuis un téléphone (PWA).

État : **Lot 0 + Lot 1** — socle, entrée de stock par photo (Gemini), mode campagne,
hors ligne, export Excel. La sortie par photo, l'apogée et la cote iDealwine arrivent
au lot 2 (voir `cahier-des-charges.md`).

## Déploiement (même serveur que magazine-search)

1. `cp .env.example .env` et remplir les secrets (`openssl rand -hex 32`).
2. Créer un client OAuth Google (type « Application Web »), URI de redirection
   `https://<sous-domaine>/api/auth/google/callback`, scopes `openid email profile`.
3. `docker compose pull && docker compose up -d`.
4. Autoriser les adresses du foyer (étape obligatoire au premier démarrage : sans
   ligne dans `allowed_email`, toute connexion Google est refusée et renvoyée sur
   `/login?error=unauthorized`) :
   `docker compose exec postgres psql -U cave -d cave -c "insert into allowed_email(email) values ('vous@gmail.com');"`
   Les adresses doivent être saisies en minuscules : la liste blanche est comparée à l'adresse Google normalisée en minuscules.
   Pour garder une porte d'entrée si Google est indisponible, remplir
   `BREAK_GLASS_EMAIL` et `BREAK_GLASS_PASSWORD` (12 caractères minimum) dans `.env` :
   l'api crée alors un compte local utilisable via « Compte de secours » sur l'écran de
   connexion. Laisser les deux vides ne crée aucun compte local.
5. Dans Nginx Proxy Manager : proxy host `<sous-domaine>` → `<ip-docker>:${WEB_PORT}`, certificat Let's Encrypt, websockets activés.
6. Sur iPhone : Partager → Sur l'écran d'accueil. Sur Android : bannière d'installation.

## Développement

    docker run -d --name cave-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=cave -p 5432:5432 postgres:16-alpine
    docker run -d --name cave-redis -p 6379:6379 redis:7-alpine
    cd api && npm ci && npx prisma migrate deploy && npm run seed && npm run start:dev
    cd api && npm run start:worker:dev
    cd web && npm ci && npm run dev

Tests : `cd api && npm test`, `cd web && npm test`.

## Sauvegarde et restauration

`db-backup` dépose un `pg_dump` compressé chaque jour dans `BACKUP_DIR` (rétention 30 jours).
Le nom définitif n'apparaît qu'une fois le dump et la compression réussis : un fichier
`cave-*.sql.gz` est donc toujours complet. Les dumps sont faits avec `--clean --if-exists`,
ils se restaurent par-dessus un schéma existant (les objets sont supprimés puis recréés).
Restauration : `gunzip -c backups/cave-<date>.sql.gz | docker compose exec -T postgres psql -U cave -d cave`.
Les photos vivent dans le volume `photo_data` — à synchroniser vers le NAS chaque semaine.

## Limites du lot 1

- **Référentiel des appellations** : 145 AOC sont chargées au démarrage (sur environ 360
  reconnues par l'INAO). Une appellation qui n'est pas dans le référentiel est conservée
  telle qu'elle a été lue ou saisie ; seule une correspondance quasi exacte (similarité
  ≥ 0,8) réécrit le libellé avec le nom canonique.
- **`GEMINI_MONTHLY_CAP_CENTS` est un plafond approximatif** : le coût par appel est une
  estimation à l'ordre de grandeur, pas une facturation réelle. En pratique le réglage se
  comporte donc comme un nombre maximum de photos par mois, pas comme un montant garanti.
- **Compte de secours** : `BREAK_GLASS_EMAIL` / `BREAK_GLASS_PASSWORD` vides = aucun compte
  local (connexion Google uniquement). Voir l'étape 4 du déploiement.
- **Sortie de stock par photo, apogée et cote iDealwine** : lot 2.

## Stack

NestJS (api + worker BullMQ), PostgreSQL 16 + pg_trgm, Redis 7, React + Vite PWA, Gemini pour la lecture d'étiquettes.
