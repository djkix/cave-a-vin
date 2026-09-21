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
4. Autoriser les adresses du foyer :
   `docker compose exec postgres psql -U cave -d cave -c "insert into allowed_email(email) values ('vous@gmail.com');"`
   Les adresses doivent être saisies en minuscules : la liste blanche est comparée à l'adresse Google normalisée en minuscules.
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
Restauration : `gunzip -c backups/cave-<date>.sql.gz | docker compose exec -T postgres psql -U cave -d cave`.
Les photos vivent dans le volume `photo_data` — à synchroniser vers le NAS chaque semaine.

## Stack

NestJS (api + worker BullMQ), PostgreSQL 16 + pg_trgm, Redis 7, React + Vite PWA, Gemini pour la lecture d'étiquettes.
