# Cave & Terroir — Lot 0 + Lot 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deployable socle (Lot 0) and the photo-based stock-entry flow with Excel export (Lot 1) of the Cave & Terroir wine-cellar PWA, ready to run on the existing homelab next to `magazine-search`.

**Architecture:** A NestJS/TypeScript codebase serves two processes from one Docker image — `api` (REST + SSE + auth) and `worker` (BullMQ jobs calling Gemini vision). PostgreSQL 16 (Prisma ORM + raw SQL for the `pg_trgm` extension, the no-negative-stock trigger and the `stock_courant` materialized view) holds an append-only movement journal. A React + Vite PWA (`web`) captures photos with the native camera, queues them offline in IndexedDB, and confirms every stock write on screen.

**Tech Stack:** Node.js 22, TypeScript 5 (strict), NestJS 10, Prisma 5, PostgreSQL 16 + `pg_trgm`, Redis 7 + BullMQ, `@google/generative-ai` (Gemini), `sharp`, `exceljs`, Passport (`passport-google-oauth20`), `express-session` + `connect-redis`, `argon2`, Jest (api), React 18 + Vite 5 + `vite-plugin-pwa` + React Router + TanStack Query + `idb`, Vitest + Testing Library (web), Docker Compose, GitHub Actions + GHCR + release-please.

**Spec:** [`docs/superpowers/specs/2026-09-20-cave-a-vin-lot0-1-design.md`](../specs/2026-09-20-cave-a-vin-lot0-1-design.md) — which itself builds on [`cahier-des-charges.md`](../../../cahier-des-charges.md) and the mockups in [`docs/design-reference/`](../../design-reference/).

## Global Constraints

- Node.js **22**, TypeScript **strict** mode everywhere; the api and worker are one NestJS codebase and one Docker image, started with different commands.
- PostgreSQL **16** with the `pg_trgm` extension enabled by the first migration; Redis **7** for BullMQ and sessions.
- Secrets (`GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `POSTGRES_PASSWORD`) come only from `.env` — never hardcoded, never committed, never passed to the `web` container.
- **No silent stock write:** a movement is only inserted after an explicit user confirmation (per-photo confirmation screen, or the bulk confirm of the campaign review).
- **Stock never negative:** enforced by a database trigger on `movement`, with the French message « il ne reste aucune bouteille de ce vin ».
- **`movement` is append-only:** cancellation inserts an inverse movement; no row is ever updated or deleted.
- **Idempotence:** every movement carries a client-generated `idempotencyKey` (unique in DB); every photo carries a `contentHash` (unique in DB). A duplicate submission returns the existing row instead of creating a second one.
- `photo.raw_extraction` stores the Gemini JSON **unmodified**, forever.
- Zero manual typing in the normal flow: every field on the confirmation screen is pre-filled from extraction or referential matching; typing is only a correction.
- Camera capture uses `<input type="file" accept="image/*" capture="environment">`, never a `getUserMedia` viewfinder.
- Offline queue: max **20 photos / 50 MB**, flushed only in the foreground (app open, `online` event, periodic retry) — no Background Sync dependency.
- Excel export is regenerated in full on every request; there is no scheduled or automatic export, and no export ever triggers a price lookup.
- Design tokens live in one versioned JSON file compiled to CSS custom properties; **no colour, spacing or radius value is hardcoded in a component**. Serif (Noto Serif) for producer/cuvée/appellation names and screen titles; sans (Manrope) for every number, quantity, label and form field.
- All user-facing copy is in **French**.
- Deployment conventions mirror `djkix/magazine-search`: images on `ghcr.io/djkix/cave-a-vin-api` and `ghcr.io/djkix/cave-a-vin-web`, only `web` publishes a host port, everything else stays on the Docker network `internal`.

---

## File structure

```
cave-a-vin/
├── api/                                # NestJS — api + worker
│   ├── package.json
│   ├── tsconfig.json / tsconfig.build.json
│   ├── jest.config.ts
│   ├── nest-cli.json
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   │       └── 20260920000000_init/migration.sql
│   ├── data/appellations.json          # référentiel AOC chargé au déploiement
│   └── src/
│       ├── main.ts                     # entrypoint api (HTTP)
│       ├── worker.ts                   # entrypoint worker (BullMQ)
│       ├── app.module.ts
│       ├── config/env.ts               # validation zod des variables d'environnement
│       ├── health/health.controller.ts
│       ├── prisma/prisma.module.ts, prisma.service.ts
│       ├── auth/                       # Google OIDC, session, liste blanche, compte de secours
│       ├── appellations/               # référentiel + recherche floue pg_trgm
│       ├── wines/                      # clé de matching, dédoublonnage
│       ├── photos/                     # upload, normalisation sharp, stockage, SSE
│       ├── vision/                     # VisionProvider + GeminiVisionProvider
│       ├── queue/                      # BullMQ queue + processor d'extraction
│       ├── movements/                  # journal, idempotence, annulation
│       └── export/                     # classeur ExcelJS
├── web/                                # React + Vite PWA
│   ├── package.json, tsconfig.json, vite.config.ts, vitest.config.ts
│   ├── index.html
│   ├── Dockerfile, nginx.conf, .dockerignore
│   ├── public/icons/…
│   ├── scripts/build-tokens.mjs        # tokens.json -> tokens.css
│   └── src/
│       ├── main.tsx, App.tsx, router.tsx
│       ├── design-tokens/tokens.json, tokens.css (généré)
│       ├── lib/api-client.ts, offline-queue.ts, sse.ts
│       ├── components/                 # Button, QuantityPicker, ConfidenceBadge, OfflineQueueBanner, BottomNav, TopBar
│       └── pages/                      # Login, Home, EntreeCapture, EntreeConfirmation, CampagneReview, Journal
├── docker-compose.yml
├── .env.example
├── ops/pg_backup.sh
├── .github/workflows/ci.yml, docker-build.yml, release-please.yml
├── release-please-config.json, .release-please-manifest.json
├── README.md
└── docs/ (spec, plan, cahier des charges, maquettes)
```

---

## Lot 0 — Socle

### Task 1: Monorepo scaffold — api and web skeletons with a passing test each

**Files:**
- Create: `api/package.json`, `api/tsconfig.json`, `api/tsconfig.build.json`, `api/nest-cli.json`, `api/jest.config.ts`, `api/.eslintrc.cjs`, `api/src/main.ts`, `api/src/app.module.ts`, `api/src/health/health.controller.ts`, `api/src/health/health.controller.spec.ts`
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/App.test.tsx`, `web/src/test-setup.ts`
- Create: `.gitignore`, `.prettierrc`, `.editorconfig`

**Interfaces:**
- Produces: `GET /api/health` → `{ status: 'ok' }`; the Nest app is created with global prefix `api`; `web` renders `<App />` with a French title « Cave & Terroir ».

- [ ] **Step 1: Root files**

`.gitignore`:
```
node_modules/
dist/
coverage/
.env
*.log
.DS_Store
web/src/design-tokens/tokens.css
api/data/photos/
backups/
```

`.prettierrc`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

`.editorconfig`:
```
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
```

- [ ] **Step 2: api package and configs**

`api/package.json`:
```json
{
  "name": "cave-a-vin-api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "node dist/main.js",
    "start:worker": "node dist/worker.js",
    "start:dev": "nest start --watch",
    "start:worker:dev": "ts-node -r tsconfig-paths/register src/worker.ts",
    "lint": "eslint \"src/**/*.ts\"",
    "test": "jest",
    "test:watch": "jest --watch",
    "prisma:generate": "prisma generate",
    "prisma:migrate:dev": "prisma migrate dev",
    "prisma:migrate:deploy": "prisma migrate deploy",
    "seed": "ts-node src/appellations/appellations.seed.ts"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/passport": "^10.0.3",
    "@nestjs/platform-express": "^10.4.0",
    "@prisma/client": "^5.20.0",
    "argon2": "^0.41.0",
    "bullmq": "^5.12.0",
    "connect-redis": "^7.1.1",
    "exceljs": "^4.4.0",
    "express-session": "^1.18.0",
    "ioredis": "^5.4.1",
    "multer": "^1.4.5-lts.1",
    "passport": "^0.7.0",
    "passport-google-oauth20": "^2.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "sharp": "^0.33.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/testing": "^10.4.0",
    "@types/express": "^4.17.21",
    "@types/express-session": "^1.18.0",
    "@types/jest": "^29.5.12",
    "@types/multer": "^1.4.12",
    "@types/node": "^22.5.0",
    "@types/passport-google-oauth20": "^2.0.16",
    "@typescript-eslint/eslint-plugin": "^8.5.0",
    "@typescript-eslint/parser": "^8.5.0",
    "eslint": "^8.57.0",
    "jest": "^29.7.0",
    "prisma": "^5.20.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.5.4"
  }
}
```

`api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

`api/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["node_modules", "dist", "**/*.spec.ts"] }
```

`api/nest-cli.json`:
```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src" }
```

`api/jest.config.ts`:
```ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
};

export default config;
```

`api/.eslintrc.cjs`:
```js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  root: true,
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.cjs', 'dist', 'jest.config.ts'],
};
```

- [ ] **Step 3: Write the failing health test**

`api/src/health/health.controller.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns status ok', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    const controller = moduleRef.get(HealthController);
    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `cd api && npm install && npx jest src/health`
Expected: FAIL — `Cannot find module './health.controller'`.

- [ ] **Step 5: Implement health controller, app module, main**

`api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

`api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  controllers: [HealthController],
})
export class AppModule {}
```

`api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
```

- [ ] **Step 6: Run the api test to see it pass**

Run: `cd api && npx jest src/health`
Expected: PASS (1 test).

- [ ] **Step 7: web package and configs**

`web/package.json`:
```json
{
  "name": "cave-a-vin-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "npm run tokens && tsc --noEmit && vite build",
    "preview": "vite preview",
    "tokens": "node scripts/build-tokens.mjs",
    "lint": "eslint \"src/**/*.{ts,tsx}\"",
    "test": "npm run tokens && vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.56.0",
    "idb": "^8.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@typescript-eslint/eslint-plugin": "^8.5.0",
    "@typescript-eslint/parser": "^8.5.0",
    "@vitejs/plugin-react": "^4.3.1",
    "eslint": "^8.57.0",
    "eslint-plugin-react-hooks": "^4.6.2",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vite-plugin-pwa": "^0.20.5",
    "vitest": "^2.1.0"
  }
}
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
```

`web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

`web/src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
```

`web/index.html`:
```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Cave & Terroir</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/scripts/build-tokens.mjs` (placeholder-free stub; Task 14 replaces it with the real generator):
```js
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('src/design-tokens', { recursive: true });
writeFileSync('src/design-tokens/tokens.css', ':root {}\n');
```

- [ ] **Step 8: Write the failing App test**

`web/src/App.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { App } from './App';

it('affiche le titre de l’application', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Cave & Terroir' })).toBeInTheDocument();
});
```

- [ ] **Step 9: Run it to see it fail**

Run: `cd web && npm install && npx vitest run`
Expected: FAIL — `Failed to resolve import "./App"`.

- [ ] **Step 10: Implement App and main**

`web/src/App.tsx`:
```tsx
export function App() {
  return (
    <main>
      <h1>Cave &amp; Terroir</h1>
    </main>
  );
}
```

`web/src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './design-tokens/tokens.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 11: Run the web test to see it pass**

Run: `cd web && npm test`
Expected: PASS (1 test).

- [ ] **Step 12: Commit**

```bash
git add .gitignore .prettierrc .editorconfig api web
git commit -m "chore: scaffold api (NestJS) and web (Vite PWA) skeletons with smoke tests"
```

---

### Task 2: Database schema and initial migration (Prisma + raw SQL)

**Files:**
- Create: `api/prisma/schema.prisma`, `api/prisma/migrations/migration_lock.toml`, `api/prisma/migrations/20260920000000_init/migration.sql`
- Create: `api/src/prisma/prisma.service.ts`, `api/src/prisma/prisma.module.ts`, `api/src/config/env.ts`
- Create: `api/src/prisma/stock.integration.spec.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Produces: Prisma models `Appellation`, `Wine`, `Movement`, `Photo`, `AppUser`, `AllowedEmail`, `ExportLog`; enums `WineColor { ROUGE BLANC ROSE PETILLANT }`, `MovementType { IN OUT ADJUST }`, `PhotoStatus { PENDING PROCESSING DONE FAILED }`; `PrismaService extends PrismaClient` injectable; `loadEnv(): Env` with `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `WEB_ORIGIN`, `PHOTO_STORAGE_DIR`, `BREAK_GLASS_EMAIL?`, `BREAK_GLASS_PASSWORD?`, `GEMINI_MONTHLY_CAP_CENTS`.
- Produces (SQL): materialized view `stock_courant(wine_id, quantity)` refreshed by trigger; trigger `trg_check_stock_non_negative` on `movement`.

- [ ] **Step 1: Prisma schema**

`api/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum WineColor {
  ROUGE
  BLANC
  ROSE
  PETILLANT
}

enum MovementType {
  IN
  OUT
  ADJUST
}

enum PhotoStatus {
  PENDING
  PROCESSING
  DONE
  FAILED
}

model Appellation {
  id            String      @id @default(uuid())
  canonicalName String      @unique @map("canonical_name")
  region        String?
  allowedColors WineColor[] @map("allowed_colors")
  guardMinYears Int?        @map("guard_min_years")
  guardMaxYears Int?        @map("guard_max_years")
  wines         Wine[]

  @@map("appellation")
}

model Wine {
  id             String       @id @default(uuid())
  matchKey       String       @unique @map("match_key")
  producer       String
  cuvee          String?
  appellationId  String?      @map("appellation_id")
  appellation    Appellation? @relation(fields: [appellationId], references: [id])
  appellationRaw String       @map("appellation_raw")
  vintage        Int?
  color          WineColor
  formatCl       Int          @default(75) @map("format_cl")
  apogeeMin      Int?         @map("apogee_min")
  apogeeMax      Int?         @map("apogee_max")
  apogeeSource   String?      @map("apogee_source")
  idealwineRef   String?      @map("idealwine_ref")
  referencePhotoId String?    @map("reference_photo_id")
  createdAt      DateTime     @default(now()) @map("created_at")
  movements      Movement[]

  @@map("wine")
}

model Movement {
  id             String       @id @default(uuid())
  wineId         String       @map("wine_id")
  wine           Wine         @relation(fields: [wineId], references: [id])
  delta          Int
  type           MovementType
  occurredAt     DateTime     @default(now()) @map("occurred_at")
  photoId        String?      @map("photo_id")
  photo          Photo?       @relation(fields: [photoId], references: [id])
  priceUnitCents Int?         @map("price_unit_cents")
  note           String?
  idempotencyKey String       @unique @map("idempotency_key")
  reversesId     String?      @map("reverses_id")

  @@index([wineId, occurredAt])
  @@map("movement")
}

model Photo {
  id            String      @id @default(uuid())
  contentHash   String      @unique @map("content_hash")
  storagePath   String      @map("storage_path")
  mimeType      String      @default("image/jpeg") @map("mime_type")
  status        PhotoStatus @default(PENDING)
  rawExtraction Json?       @map("raw_extraction")
  model         String?
  latencyMs     Int?        @map("latency_ms")
  costCents     Int?        @map("cost_cents")
  errorMessage  String?     @map("error_message")
  createdAt     DateTime    @default(now()) @map("created_at")
  movements     Movement[]

  @@map("photo")
}

model AppUser {
  id           String   @id @default(uuid())
  googleSub    String?  @unique @map("google_sub")
  email        String   @unique
  displayName  String?  @map("display_name")
  isBreakGlass Boolean  @default(false) @map("is_break_glass")
  passwordHash String?  @map("password_hash")
  createdAt    DateTime @default(now()) @map("created_at")

  @@map("app_user")
}

model AllowedEmail {
  email   String   @id
  addedBy String?  @map("added_by")
  addedAt DateTime @default(now()) @map("added_at")

  @@map("allowed_email")
}

model ExportLog {
  id          String   @id @default(uuid())
  userId      String   @map("user_id")
  generatedAt DateTime @default(now()) @map("generated_at")
  filter      Json?
  rowCount    Int      @map("row_count")

  @@map("export_log")
}
```

- [ ] **Step 2: Generate the base migration, then append the raw SQL**

Run (needs a local Postgres; `docker run -d --name cave-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=cave -p 5432:5432 postgres:16-alpine` is enough):
```bash
cd api && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave npx prisma migrate dev --name init --create-only
```
Then **append** this block to the end of the generated `api/prisma/migrations/<timestamp>_init/migration.sql` (rename the folder to `20260920000000_init` for a stable name):

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_appellation_name_trgm ON appellation USING gin (canonical_name gin_trgm_ops);

-- Stock never negative (BEFORE INSERT so the failing row is rejected, not corrected)
CREATE OR REPLACE FUNCTION check_stock_non_negative() RETURNS TRIGGER AS $$
DECLARE current_stock INTEGER;
BEGIN
  IF NEW.delta = 0 THEN
    RAISE EXCEPTION 'movement.delta ne peut pas être nul';
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO current_stock FROM movement WHERE wine_id = NEW.wine_id;
  IF current_stock + NEW.delta < 0 THEN
    RAISE EXCEPTION 'il ne reste aucune bouteille de ce vin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_stock_non_negative
BEFORE INSERT ON movement FOR EACH ROW EXECUTE FUNCTION check_stock_non_negative();

-- Current stock as a materialized view (append-only journal => stock is a SUM)
CREATE MATERIALIZED VIEW stock_courant AS
SELECT wine_id, SUM(delta)::INTEGER AS quantity FROM movement GROUP BY wine_id;
CREATE UNIQUE INDEX idx_stock_courant_wine_id ON stock_courant (wine_id);

-- Plain REFRESH (not CONCURRENTLY): CONCURRENTLY cannot run inside a transaction block,
-- and a trigger always runs inside the inserting transaction.
CREATE OR REPLACE FUNCTION refresh_stock_courant() RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW stock_courant;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_stock_courant
AFTER INSERT ON movement FOR EACH STATEMENT EXECUTE FUNCTION refresh_stock_courant();
```

`api/prisma/migrations/migration_lock.toml`:
```toml
provider = "postgresql"
```

- [ ] **Step 3: Env loader and PrismaService**

`api/src/config/env.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:3000/api/auth/google/callback'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash'),
  GEMINI_MONTHLY_CAP_CENTS: z.coerce.number().int().default(500),
  PHOTO_STORAGE_DIR: z.string().default('./data/photos'),
  BREAK_GLASS_EMAIL: z.string().email().optional(),
  BREAK_GLASS_PASSWORD: z.string().min(12).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
```

`api/src/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

`api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

Modify `api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 4: Write the failing integration test for the trigger and the view**

`api/src/prisma/stock.integration.spec.ts` (runs only when `DATABASE_URL` is set; CI provides a Postgres service in Task 5):
```ts
import { PrismaClient, WineColor } from '@prisma/client';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('stock journal (trigger + stock_courant)', () => {
  const prisma = new PrismaClient();
  let wineId: string;

  beforeAll(async () => {
    const wine = await prisma.wine.create({
      data: {
        matchKey: `test|${Date.now()}`,
        producer: 'Domaine Test',
        appellationRaw: 'Test AOC',
        color: WineColor.ROUGE,
      },
    });
    wineId = wine.id;
  });

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId } });
    await prisma.wine.delete({ where: { id: wineId } });
    await prisma.$disconnect();
  });

  it('refuses a movement that would make stock negative', async () => {
    await expect(
      prisma.movement.create({
        data: { wineId, delta: -1, type: 'OUT', idempotencyKey: `neg-${Date.now()}` },
      }),
    ).rejects.toThrow(/il ne reste aucune bouteille/);
  });

  it('sums movements into stock_courant', async () => {
    await prisma.movement.create({
      data: { wineId, delta: 6, type: 'IN', idempotencyKey: `in6-${Date.now()}` },
    });
    await prisma.movement.create({
      data: { wineId, delta: -1, type: 'OUT', idempotencyKey: `out1-${Date.now()}` },
    });
    const rows = await prisma.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock_courant WHERE wine_id = ${wineId}::uuid`;
    expect(rows[0].quantity).toBe(5);
  });

  it('refuses a zero delta', async () => {
    await expect(
      prisma.movement.create({
        data: { wineId, delta: 0, type: 'ADJUST', idempotencyKey: `zero-${Date.now()}` },
      }),
    ).rejects.toThrow(/ne peut pas être nul/);
  });
});
```

- [ ] **Step 5: Apply the migration and run the test**

Run:
```bash
cd api && export DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave && npx prisma migrate deploy && npx prisma generate && npx jest src/prisma
```
Expected: PASS (3 tests). If the trigger message does not match, check the `RAISE EXCEPTION` text in the migration.

- [ ] **Step 6: Commit**

```bash
git add api/prisma api/src/prisma api/src/config api/src/app.module.ts
git commit -m "feat(db): Prisma schema, pg_trgm, no-negative-stock trigger and stock_courant view"
```

---

### Task 3: Docker Compose, Dockerfiles and `.env.example`

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `ops/pg_backup.sh`, `api/Dockerfile`, `api/.dockerignore`, `web/Dockerfile`, `web/nginx.conf`, `web/.dockerignore`

**Interfaces:**
- Produces: services `web` (port `${WEB_PORT:-3100}` → 80), `api`, `worker`, `postgres`, `redis`, `db-backup`; volumes `postgres_data`, `redis_data`, `photo_data`; `web` proxies `/api/` to `http://api:3000/api/`.

- [ ] **Step 1: api Dockerfile**

`api/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
COPY data ./data
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

`api/.dockerignore`:
```
node_modules
dist
data/photos
.env
```

- [ ] **Step 2: web Dockerfile and nginx**

`web/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_APP_VERSION=dev
ENV VITE_APP_VERSION=$VITE_APP_VERSION
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

`web/nginx.conf`:
```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  client_max_body_size 25m;

  location /api/ {
    proxy_pass http://api:3000/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # SSE
    proxy_read_timeout 3600s;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }

  location = /sw.js { add_header Cache-Control "no-cache"; }
  location = /manifest.webmanifest { add_header Cache-Control "no-cache"; }
}
```

`web/.dockerignore`:
```
node_modules
dist
```

- [ ] **Step 3: docker-compose.yml**

`docker-compose.yml`:
```yaml
services:
  web:
    image: ghcr.io/djkix/cave-a-vin-web:${IMAGE_TAG:-latest}
    build: ./web
    restart: unless-stopped
    ports:
      - "${WEB_PORT:-3100}:80"
    depends_on:
      - api
    networks: [internal]

  api:
    image: ghcr.io/djkix/cave-a-vin-api:${IMAGE_TAG:-latest}
    build: ./api
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      PHOTO_STORAGE_DIR: /data/photos
    volumes:
      - photo_data:/data/photos
    expose: ["3000"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    networks: [internal]

  worker:
    image: ghcr.io/djkix/cave-a-vin-api:${IMAGE_TAG:-latest}
    build: ./api
    restart: unless-stopped
    command: ["node", "dist/worker.js"]
    env_file: .env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      PHOTO_STORAGE_DIR: /data/photos
    volumes:
      - photo_data:/data/photos
    depends_on:
      api: { condition: service_started }
      redis: { condition: service_healthy }
    networks: [internal]

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [internal]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [internal]

  db-backup:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      PGHOST: postgres
      PGUSER: ${POSTGRES_USER}
      PGPASSWORD: ${POSTGRES_PASSWORD}
      PGDATABASE: ${POSTGRES_DB}
      BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-30}
      BACKUP_INTERVAL_SECONDS: ${BACKUP_INTERVAL_SECONDS:-86400}
    volumes:
      - ./ops/pg_backup.sh:/usr/local/bin/pg_backup.sh:ro
      - ${BACKUP_DIR:-./backups}:/backups
    entrypoint: ["/bin/sh", "/usr/local/bin/pg_backup.sh"]
    depends_on:
      postgres: { condition: service_healthy }
    networks: [internal]

networks:
  internal:

volumes:
  postgres_data:
  redis_data:
  photo_data:
```

- [ ] **Step 4: backup script and env example**

`ops/pg_backup.sh`:
```sh
#!/bin/sh
set -eu
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  pg_dump | gzip > "/backups/cave-${ts}.sql.gz"
  find /backups -name 'cave-*.sql.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  sleep "${BACKUP_INTERVAL_SECONDS}"
done
```

`.env.example`:
```dotenv
# Copier vers .env et remplir. Ne jamais commiter .env.
# TLS et sous-domaine public sont gérés par Nginx Proxy Manager en amont.

TZ=Europe/Paris
IMAGE_TAG=latest
# Seul port publié sur l'hôte ; NPM pointe dessus (proxy host -> <ip-docker>:${WEB_PORT}).
WEB_PORT=3100

# ---- Postgres ----
POSTGRES_USER=cave
POSTGRES_PASSWORD=__REMPLACER__   # openssl rand -hex 24
POSTGRES_DB=cave

# ---- Sessions ----
SESSION_SECRET=__REMPLACER__      # openssl rand -hex 32, 32 caractères minimum
# Origine publique de l'application (redirections OAuth et cookies)
WEB_ORIGIN=https://cave.example.fr

# ---- Google OAuth (OpenID Connect, scopes openid/email/profile uniquement) ----
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://cave.example.fr/api/auth/google/callback

# ---- Compte de secours local (argon2) — laisser vide pour ne pas en créer ----
BREAK_GLASS_EMAIL=
BREAK_GLASS_PASSWORD=

# ---- Vision (Gemini) ----
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
# Plafond mensuel de dépense vision, en centimes (500 = 5 €). Au-delà, l'extraction est refusée.
GEMINI_MONTHLY_CAP_CENTS=500

# ---- Sauvegardes ----
BACKUP_DIR=./backups
BACKUP_RETENTION_DAYS=30
BACKUP_INTERVAL_SECONDS=86400
```

- [ ] **Step 5: Verify the stack builds and answers**

Run:
```bash
cp .env.example .env && sed -i '' 's/__REMPLACER__/devsecretdevsecretdevsecretdevsecret00/g' .env && docker compose build && docker compose up -d && sleep 15 && curl -s http://localhost:3100/api/health
```
Expected: `{"status":"ok"}`. Then `docker compose down`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example ops api/Dockerfile api/.dockerignore web/Dockerfile web/nginx.conf web/.dockerignore
git commit -m "feat(ops): Docker Compose stack, Dockerfiles, backup sidecar and env template"
```

### Task 4: Authentication — Google OIDC, whitelist, session cookie, break-glass account

**Files:**
- Create: `api/src/auth/auth.module.ts`, `api/src/auth/auth.service.ts`, `api/src/auth/auth.service.spec.ts`, `api/src/auth/google.strategy.ts`, `api/src/auth/session.serializer.ts`, `api/src/auth/authenticated.guard.ts`, `api/src/auth/auth.controller.ts`, `api/src/auth/session.setup.ts`, `api/src/auth/current-user.decorator.ts`
- Modify: `api/src/main.ts`, `api/src/app.module.ts`

**Interfaces:**
- Produces: `AuthService.findOrCreateGoogleUser({ sub, email, displayName })` → `AppUser` or throws `ForbiddenException('Adresse non autorisée')`; `AuthService.verifyLocalLogin(email, password)` → `AppUser | null`; `AuthService.ensureBreakGlassAccount()`; `AuthenticatedGuard` (Nest guard reading `req.isAuthenticated()`); `@CurrentUser()` param decorator → `AppUser`; routes `GET /api/auth/google`, `GET /api/auth/google/callback`, `POST /api/auth/local-login {email,password}`, `POST /api/auth/logout`, `GET /api/auth/me`.

- [ ] **Step 1: Write the failing AuthService tests**

`api/src/auth/auth.service.spec.ts`:
```ts
import { ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

function fakePrisma() {
  const users = new Map<string, any>();
  const allowed = new Set<string>();
  return {
    allowed,
    allowedEmail: { findUnique: async ({ where }: any) => (allowed.has(where.email) ? { email: where.email } : null) },
    appUser: {
      findUnique: async ({ where }: any) => {
        for (const u of users.values()) {
          if ((where.googleSub && u.googleSub === where.googleSub) || (where.email && u.email === where.email)) return u;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const u = { id: `u${users.size + 1}`, ...data };
        users.set(u.id, u);
        return u;
      },
      update: async ({ where, data }: any) => {
        const u = [...users.values()].find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      },
    },
  };
}

describe('AuthService', () => {
  it('refuses a Google account whose email is not whitelisted', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    await expect(
      service.findOrCreateGoogleUser({ sub: '123', email: 'x@example.com', displayName: 'X' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates then reuses a whitelisted Google user, keyed by sub', async () => {
    const prisma = fakePrisma();
    prisma.allowed.add('franck@example.com');
    const service = new AuthService(prisma as any);
    const first = await service.findOrCreateGoogleUser({ sub: '123', email: 'franck@example.com', displayName: 'Franck' });
    const second = await service.findOrCreateGoogleUser({ sub: '123', email: 'new@example.com', displayName: 'Franck' });
    expect(second.id).toBe(first.id);
  });

  it('verifies the break-glass password with argon2', async () => {
    const prisma = fakePrisma();
    const hash = await argon2.hash('correct horse battery');
    await prisma.appUser.create({ data: { email: 'bg@example.com', isBreakGlass: true, passwordHash: hash } });
    const service = new AuthService(prisma as any);
    expect(await service.verifyLocalLogin('bg@example.com', 'wrong')).toBeNull();
    expect((await service.verifyLocalLogin('bg@example.com', 'correct horse battery'))?.email).toBe('bg@example.com');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd api && npx jest src/auth`
Expected: FAIL — cannot find `./auth.service`.

- [ ] **Step 3: Implement AuthService**

`api/src/auth/auth.service.ts`:
```ts
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export interface GoogleProfile {
  sub: string;
  email: string;
  displayName: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateGoogleUser(profile: GoogleProfile): Promise<AppUser> {
    const existing = await this.prisma.appUser.findUnique({ where: { googleSub: profile.sub } });
    if (existing) return existing;

    const allowed = await this.prisma.allowedEmail.findUnique({ where: { email: profile.email.toLowerCase() } });
    if (!allowed) throw new ForbiddenException('Adresse non autorisée');

    return this.prisma.appUser.create({
      data: { googleSub: profile.sub, email: profile.email.toLowerCase(), displayName: profile.displayName },
    });
  }

  async verifyLocalLogin(email: string, password: string): Promise<AppUser | null> {
    const user = await this.prisma.appUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.isBreakGlass || !user.passwordHash) return null;
    return (await argon2.verify(user.passwordHash, password)) ? user : null;
  }

  async ensureBreakGlassAccount(): Promise<void> {
    const env = loadEnv();
    if (!env.BREAK_GLASS_EMAIL || !env.BREAK_GLASS_PASSWORD) return;
    const passwordHash = await argon2.hash(env.BREAK_GLASS_PASSWORD);
    const email = env.BREAK_GLASS_EMAIL.toLowerCase();
    const existing = await this.prisma.appUser.findUnique({ where: { email } });
    if (existing) {
      await this.prisma.appUser.update({ where: { id: existing.id }, data: { passwordHash, isBreakGlass: true } });
    } else {
      await this.prisma.appUser.create({ data: { email, isBreakGlass: true, passwordHash, displayName: 'Secours' } });
    }
    this.logger.log(`Compte de secours prêt pour ${email}`);
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd api && npx jest src/auth`
Expected: PASS (3 tests).

- [ ] **Step 5: Passport strategy, serializer, guard, decorator, controller, session setup**

`api/src/auth/google.strategy.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { loadEnv } from '../config/env';
import { AuthService } from './auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly auth: AuthService) {
    const env = loadEnv();
    super({
      clientID: env.GOOGLE_CLIENT_ID || 'unset',
      clientSecret: env.GOOGLE_CLIENT_SECRET || 'unset',
      callbackURL: env.GOOGLE_CALLBACK_URL,
      scope: ['openid', 'email', 'profile'],
    });
  }

  async validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error('Profil Google sans adresse e-mail');
    return this.auth.findOrCreateGoogleUser({ sub: profile.id, email, displayName: profile.displayName });
  }
}
```

`api/src/auth/session.serializer.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';
import { AppUser } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly prisma: PrismaService) {
    super();
  }
  serializeUser(user: AppUser, done: (err: Error | null, id: string) => void) {
    done(null, user.id);
  }
  async deserializeUser(id: string, done: (err: Error | null, user: AppUser | null) => void) {
    done(null, await this.prisma.appUser.findUnique({ where: { id } }));
  }
}
```

`api/src/auth/authenticated.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class AuthenticatedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.isAuthenticated && req.isAuthenticated()) return true;
    throw new UnauthorizedException('Connexion requise');
  }
}
```

`api/src/auth/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AppUser } from '@prisma/client';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AppUser => {
  return ctx.switchToHttp().getRequest().user as AppUser;
});
```

`api/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppUser } from '@prisma/client';
import { Request, Response } from 'express';
import { loadEnv } from '../config/env';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  google() {}

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  googleCallback(@Req() req: Request, @Res() res: Response) {
    req.logIn(req.user as AppUser, (err) => {
      if (err) return res.redirect(`${loadEnv().WEB_ORIGIN}/login?error=session`);
      return res.redirect(loadEnv().WEB_ORIGIN);
    });
  }

  @Post('local-login')
  async localLogin(@Body() body: { email: string; password: string }, @Req() req: Request) {
    const user = await this.auth.verifyLocalLogin(body.email ?? '', body.password ?? '');
    if (!user) throw new UnauthorizedException('Identifiants invalides');
    await new Promise<void>((resolve, reject) => req.logIn(user, (err) => (err ? reject(err) : resolve())));
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  @Post('logout')
  async logout(@Req() req: Request) {
    await new Promise<void>((resolve) => req.logout(() => resolve()));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthenticatedGuard)
  me(@CurrentUser() user: AppUser) {
    return { id: user.id, email: user.email, displayName: user.displayName };
  }
}
```

`api/src/auth/session.setup.ts`:
```ts
import { INestApplication } from '@nestjs/common';
import RedisStore from 'connect-redis';
import session from 'express-session';
import Redis from 'ioredis';
import passport from 'passport';
import { loadEnv } from '../config/env';

export function setupSession(app: INestApplication) {
  const env = loadEnv();
  const client = new Redis(env.REDIS_URL);
  app.use(
    session({
      store: new RedisStore({ client, prefix: 'cave:sess:' }),
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      name: 'cave.sid',
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30,
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());
}
```

`api/src/auth/auth.module.ts`:
```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticatedGuard } from './authenticated.guard';
import { GoogleStrategy } from './google.strategy';
import { SessionSerializer } from './session.serializer';

@Module({
  imports: [PassportModule.register({ session: true })],
  controllers: [AuthController],
  providers: [AuthService, GoogleStrategy, SessionSerializer, AuthenticatedGuard],
  exports: [AuthService, AuthenticatedGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(private readonly auth: AuthService) {}
  async onModuleInit() {
    await this.auth.ensureBreakGlassAccount();
  }
}
```

Modify `api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSession } from './auth/session.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  setupSession(app);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
```

Modify `api/src/app.module.ts` — add `AuthModule` to `imports`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 6: Manual check of the break-glass login**

Run (Postgres + Redis running locally, `.env` exporting `SESSION_SECRET`, `DATABASE_URL`, `REDIS_URL`, `BREAK_GLASS_EMAIL=bg@example.com`, `BREAK_GLASS_PASSWORD=correct-horse-battery`):
```bash
cd api && npm run start:dev
```
Then:
```bash
curl -s -c /tmp/c.txt -H 'Content-Type: application/json' -d '{"email":"bg@example.com","password":"correct-horse-battery"}' http://localhost:3000/api/auth/local-login && curl -s -b /tmp/c.txt http://localhost:3000/api/auth/me
```
Expected: both calls return the user JSON; `GET /api/auth/me` without the cookie returns 401.

- [ ] **Step 7: Commit**

```bash
git add api/src/auth api/src/main.ts api/src/app.module.ts
git commit -m "feat(auth): Google OIDC with e-mail whitelist, Redis sessions and argon2 break-glass login"
```

---

### Task 5: CI/CD — lint + tests, GHCR image publishing, release-please, README

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/docker-build.yml`, `.github/workflows/release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`, `README.md`, `LICENSE`

**Interfaces:**
- Produces: on every push/PR — api lint+tests (with a Postgres service so `stock.integration.spec.ts` runs) and web lint+tests; on push to `main` or tag `v*` — images `ghcr.io/djkix/cave-a-vin-api` and `-web` tagged `latest` and the version.

- [ ] **Step 1: ci.yml**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  api:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: cave, POSTGRES_PASSWORD: cave, POSTGRES_DB: cave }
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U cave" --health-interval 5s --health-timeout 3s --health-retries 10
    env:
      DATABASE_URL: postgresql://cave:cave@localhost:5432/cave
      SESSION_SECRET: ci-secret-ci-secret-ci-secret-ci-secret
    defaults: { run: { working-directory: api } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: api/package-lock.json }
      - run: npm ci
      - run: npx prisma migrate deploy
      - run: npx prisma generate
      - run: npm run lint
      - run: npm test

  web:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: docker-build.yml**

`.github/workflows/docker-build.yml`:
```yaml
name: Build and publish images
on:
  push:
    tags: ["v*.*.*"]
    branches: [main]
  workflow_call:
    inputs:
      tag: { description: "Version tag (e.g. v0.1.0)", required: true, type: string }

permissions: { contents: read, packages: write }

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency: { group: docker-build-${{ matrix.image }}, cancel-in-progress: false }
    strategy:
      matrix:
        include:
          - { image: api, context: ./api }
          - { image: web, context: ./web }
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ inputs.tag || github.sha }}" }
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - id: version
        run: |
          if [ -n "${{ inputs.tag }}" ]; then TAG="${{ inputs.tag }}";
          elif [ "${{ github.ref_type }}" = "tag" ]; then TAG="${{ github.ref_name }}";
          else TAG=""; fi
          echo "value=${TAG#v}" >> "$GITHUB_OUTPUT"
          if [ -n "$TAG" ]; then echo "display=${TAG#v}" >> "$GITHUB_OUTPUT";
          else echo "display=$(python3 -c "import json; print(json.load(open('.release-please-manifest.json'))['.'])")" >> "$GITHUB_OUTPUT"; fi
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}-${{ matrix.image }}
          tags: |
            type=raw,value=${{ steps.version.outputs.value }},enable=${{ steps.version.outputs.value != '' }}
            type=raw,value=latest
      - uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: VITE_APP_VERSION=${{ steps.version.outputs.display }}
          cache-from: type=gha,scope=${{ matrix.image }}
          cache-to: type=gha,mode=max,scope=${{ matrix.image }}
```

- [ ] **Step 3: release-please**

`.github/workflows/release-please.yml`:
```yaml
name: Release Please
on:
  push:
    branches: [main]
permissions: { contents: write, pull-requests: write, packages: write }
jobs:
  release:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.rp.outputs.release_created }}
      tag_name: ${{ steps.rp.outputs.tag_name }}
    steps:
      - id: rp
        uses: googleapis/release-please-action@v4
        with: { config-file: release-please-config.json, manifest-file: .release-please-manifest.json }
  images:
    needs: release
    if: ${{ needs.release.outputs.release_created == 'true' }}
    uses: ./.github/workflows/docker-build.yml
    with: { tag: "${{ needs.release.outputs.tag_name }}" }
    permissions: { contents: read, packages: write }
```

`release-please-config.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": { ".": { "release-type": "simple", "changelog-path": "CHANGELOG.md", "tag-separator": "", "bump-minor-pre-major": true } }
}
```

`.release-please-manifest.json`:
```json
{ ".": "0.0.0" }
```

- [ ] **Step 4: README and LICENSE**

`LICENSE`: MIT text with `Copyright (c) 2026 Franck Laval`.

`README.md`:
```markdown
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
   `docker compose exec postgres psql -U cave -d cave -c "INSERT INTO allowed_email(email) VALUES ('vous@gmail.com');"`
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
```

- [ ] **Step 5: Validate workflow syntax locally**

Run: `npx --yes @action-validator/cli .github/workflows/ci.yml .github/workflows/docker-build.yml .github/workflows/release-please.yml` (or `actionlint` if installed).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add .github release-please-config.json .release-please-manifest.json README.md LICENSE
git commit -m "ci: lint/test pipeline, GHCR image publishing and release-please"
```

---

### Task 6: PWA shell — manifest, service worker, login page, gated home with bottom navigation

**Files:**
- Create: `web/public/icons/icon-192.png`, `web/public/icons/icon-512.png`, `web/public/icons/apple-touch-icon.png` (generate: `npx --yes pwa-asset-generator` or any 512×512 PNG with the `wine_bar` glyph on `#8B612C`)
- Create: `web/src/lib/api-client.ts`, `web/src/lib/api-client.test.ts`, `web/src/router.tsx`, `web/src/pages/LoginPage.tsx`, `web/src/pages/HomePage.tsx`, `web/src/pages/HomePage.test.tsx`, `web/src/components/BottomNav.tsx`, `web/src/components/TopBar.tsx`, `web/src/components/RequireAuth.tsx`
- Modify: `web/vite.config.ts`, `web/src/App.tsx`, `web/src/App.test.tsx`, `web/src/main.tsx`, `web/index.html`

**Interfaces:**
- Produces: `api-client.ts` exports `apiFetch<T>(path, init?)` (throws `ApiError {status, message}`), `getMe()`, `localLogin(email, password)`, `logout()`; `RequireAuth` redirects to `/login` on 401; routes `/login`, `/` (home), `/entree` (Task 15), `/entree/campagne` (Task 17), `/journal` (Task 18); `BottomNav` with tabs Cave · Entrée · Sortie · Journal (Cave and Sortie rendered disabled with « Bientôt »).

- [ ] **Step 1: vite-plugin-pwa configuration**

Modify `web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Cave & Terroir',
        short_name: 'Cave',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#FCF9F3',
        theme_color: '#8B612C',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } },
});
```

Add to `web/index.html` `<head>`:
```html
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="theme-color" content="#8B612C" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Noto+Serif:wght@400;500;600&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
```

- [ ] **Step 2: Failing api-client test**

`web/src/lib/api-client.test.ts`:
```ts
import { apiFetch, ApiError } from './api-client';

describe('apiFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns parsed JSON on 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(apiFetch<{ ok: number }>('/health')).resolves.toEqual({ ok: 1 });
  });

  it('throws ApiError with the server message on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Connexion requise' }), { status: 401 }),
    );
    await expect(apiFetch('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Connexion requise' });
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `cd web && npx vitest run src/lib`
Expected: FAIL — cannot resolve `./api-client`.

- [ ] **Step 4: Implement api-client**

`web/src/lib/api-client.ts`:
```ts
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
}

export const getMe = () => apiFetch<Me>('/auth/me');
export const localLogin = (email: string, password: string) =>
  apiFetch<Me>('/auth/local-login', { method: 'POST', body: JSON.stringify({ email, password }) });
export const logout = () => apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });
```

- [ ] **Step 5: Run to see it pass**

Run: `cd web && npx vitest run src/lib`
Expected: PASS (2 tests).

- [ ] **Step 6: Failing HomePage test**

`web/src/pages/HomePage.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './HomePage';

it('propose Rentrer et marque Sortir comme bientôt disponible', () => {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
  expect(screen.getByRole('button', { name: /Sortir une bouteille/ })).toBeDisabled();
  expect(screen.getByText(/Bientôt/)).toBeInTheDocument();
});
```

- [ ] **Step 7: Run to see it fail**

Run: `cd web && npx vitest run src/pages`
Expected: FAIL — cannot resolve `./HomePage`.

- [ ] **Step 8: Implement shell components and pages**

`web/src/components/TopBar.tsx`:
```tsx
import { Link } from 'react-router-dom';

export function TopBar({ title, back }: { title?: string; back?: string }) {
  return (
    <header className="topbar">
      {back ? (
        <Link to={back} aria-label="Retour" className="topbar__back">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
      ) : (
        <span className="material-symbols-outlined topbar__logo">wine_bar</span>
      )}
      <h1 className="topbar__title">{title ?? 'Cave & Terroir'}</h1>
    </header>
  );
}
```

`web/src/components/BottomNav.tsx`:
```tsx
import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/cave', icon: 'shelves', label: 'Cave', soon: true },
  { to: '/entree', icon: 'add_circle', label: 'Entrée', soon: false },
  { to: '/sortie', icon: 'remove_circle_outline', label: 'Sortie', soon: true },
  { to: '/journal', icon: 'history_edu', label: 'Journal', soon: false },
];

export function BottomNav() {
  return (
    <nav className="bottomnav" aria-label="Navigation principale">
      {tabs.map((t) =>
        t.soon ? (
          <span key={t.to} className="bottomnav__tab bottomnav__tab--soon" aria-disabled="true" title="Bientôt disponible">
            <span className="material-symbols-outlined">{t.icon}</span>
            <span>{t.label}</span>
          </span>
        ) : (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => `bottomnav__tab${isActive ? ' bottomnav__tab--active' : ''}`}>
            <span className="material-symbols-outlined">{t.icon}</span>
            <span>{t.label}</span>
          </NavLink>
        ),
      )}
    </nav>
  );
}
```

`web/src/components/RequireAuth.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from 'react-router-dom';
import { ApiError, getMe } from '../lib/api-client';

export function RequireAuth() {
  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });
  if (me.isPending) return <p className="centered">Chargement…</p>;
  if (me.isError && me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.isError) return <p className="centered">Serveur injoignable.</p>;
  return <Outlet />;
}
```

`web/src/pages/LoginPage.tsx`:
```tsx
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { localLogin } from '../lib/api-client';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showLocal, setShowLocal] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await localLogin(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connexion impossible');
    }
  }

  return (
    <main className="login">
      <span className="material-symbols-outlined login__logo">wine_bar</span>
      <h1 className="login__title">Cave &amp; Terroir</h1>
      <a className="btn btn--primary" href="/api/auth/google">
        Se connecter avec Google
      </a>
      <button type="button" className="btn btn--link" onClick={() => setShowLocal((v) => !v)}>
        Compte de secours
      </button>
      {showLocal && (
        <form onSubmit={submit} className="login__form">
          <label>
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Mot de passe
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p role="alert" className="text-error">{error}</p>}
          <button type="submit" className="btn btn--dark">Connexion</button>
        </form>
      )}
    </main>
  );
}
```

`web/src/pages/HomePage.tsx`:
```tsx
import { Link } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { TopBar } from '../components/TopBar';

export function HomePage() {
  return (
    <>
      <TopBar />
      <main className="page">
        <section className="actions">
          <Link to="/entree" className="action action--in">
            <span className="material-symbols-outlined">qr_code_scanner</span>
            <span className="action__text">
              <strong>Rentrer du vin</strong>
              <small>Arrivage de cartons (6, 12, 18) ou bouteilles</small>
            </span>
            <span className="material-symbols-outlined">arrow_forward</span>
          </Link>
          <button type="button" className="action action--out" disabled>
            <span className="material-symbols-outlined">remove_circle_outline</span>
            <span className="action__text">
              <strong>Sortir une bouteille</strong>
              <small>Bientôt disponible (lot 2)</small>
            </span>
          </button>
        </section>
        <Link to="/entree/campagne" className="btn btn--outline">
          Mode campagne (reprise de l'existant)
        </Link>
      </main>
      <BottomNav />
    </>
  );
}
```

`web/src/router.tsx`:
```tsx
import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <HomePage /> }],
  },
]);
```

Modify `web/src/App.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

Modify `web/src/App.test.tsx` (the App now needs a fetch; keep it a smoke test of the login route):
```tsx
import { render, screen } from '@testing-library/react';
import { App } from './App';

it('rend l’application (route /login sans session)', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"Connexion requise"}', { status: 401 }));
  window.history.pushState({}, '', '/');
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Cave & Terroir' })).toBeInTheDocument();
});
```

- [ ] **Step 9: Run web tests**

Run: `cd web && npm test`
Expected: PASS (4 tests: App, api-client ×2, HomePage).

- [ ] **Step 10: Manual check in the browser**

Run api (`npm run start:dev`) and web (`npm run dev`), open `http://localhost:5173`: unauthenticated → `/login`; break-glass login → home with *Rentrer du vin* active, *Sortir* disabled, bottom nav present; Chrome DevTools → Application → Manifest shows « Cave & Terroir », installable.

- [ ] **Step 11: Commit**

```bash
git add web
git commit -m "feat(web): installable PWA shell with login, gated home and bottom navigation"
```

---

## Lot 1 — Entrée de stock

### Task 7: Appellation referential — seed data and pg_trgm fuzzy resolution

**Files:**
- Create: `api/data/appellations.json`, `api/src/appellations/appellations.module.ts`, `api/src/appellations/appellations.service.ts`, `api/src/appellations/appellations.service.spec.ts`, `api/src/appellations/appellations.seed.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Produces: `AppellationsService.resolve(raw: string): Promise<AppellationMatch>` where
  `type AppellationMatch = { kind: 'exact' | 'fuzzy'; id: string; canonicalName: string; similarity: number } | { kind: 'none'; raw: string }` — `similarity >= 0.8` → `'exact'` (silently aligned), `0.5 ≤ s < 0.8` → `'fuzzy'` (aligned but flagged for the confirmation screen), `< 0.5` → `'none'`. `AppellationsService.seedFromFile(path)` upserts the JSON by `canonicalName`.

- [ ] **Step 1: Seed data**

`api/data/appellations.json` — one object per AOC. Start with this shape and these 40 entries, then complete the list to the ~360 French AOC from the INAO public dataset (fields: `canonicalName`, `region`, `allowedColors` ⊂ `["ROUGE","BLANC","ROSE","PETILLANT"]`, `guardMinYears`, `guardMaxYears`; guard values from the table in the cahier des charges for the rows it lists, the rest at `[2, 8]` red / `[1, 5]` white / `[1, 3]` rosé as a first approximation to be tuned):
```json
[
  { "canonicalName": "Alsace", "region": "Alsace", "allowedColors": ["BLANC", "ROUGE", "ROSE"], "guardMinYears": 1, "guardMaxYears": 8 },
  { "canonicalName": "Alsace Grand Cru", "region": "Alsace", "allowedColors": ["BLANC"], "guardMinYears": 5, "guardMaxYears": 20 },
  { "canonicalName": "Bandol", "region": "Provence", "allowedColors": ["ROUGE", "ROSE", "BLANC"], "guardMinYears": 5, "guardMaxYears": 20 },
  { "canonicalName": "Barsac", "region": "Bordeaux", "allowedColors": ["BLANC"], "guardMinYears": 5, "guardMaxYears": 30 },
  { "canonicalName": "Beaujolais", "region": "Beaujolais", "allowedColors": ["ROUGE", "BLANC", "ROSE"], "guardMinYears": 1, "guardMaxYears": 4 },
  { "canonicalName": "Bordeaux", "region": "Bordeaux", "allowedColors": ["ROUGE", "BLANC", "ROSE"], "guardMinYears": 3, "guardMaxYears": 8 },
  { "canonicalName": "Bourgogne", "region": "Bourgogne", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 2, "guardMaxYears": 6 },
  { "canonicalName": "Chablis", "region": "Bourgogne", "allowedColors": ["BLANC"], "guardMinYears": 2, "guardMaxYears": 8 },
  { "canonicalName": "Chablis Premier Cru", "region": "Bourgogne", "allowedColors": ["BLANC"], "guardMinYears": 4, "guardMaxYears": 12 },
  { "canonicalName": "Chablis Grand Cru", "region": "Bourgogne", "allowedColors": ["BLANC"], "guardMinYears": 6, "guardMaxYears": 20 },
  { "canonicalName": "Chambolle-Musigny", "region": "Bourgogne", "allowedColors": ["ROUGE"], "guardMinYears": 5, "guardMaxYears": 15 },
  { "canonicalName": "Champagne", "region": "Champagne", "allowedColors": ["PETILLANT"], "guardMinYears": 2, "guardMaxYears": 10 },
  { "canonicalName": "Chassagne-Montrachet", "region": "Bourgogne", "allowedColors": ["BLANC", "ROUGE"], "guardMinYears": 3, "guardMaxYears": 12 },
  { "canonicalName": "Châteauneuf-du-Pape", "region": "Rhône", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 8, "guardMaxYears": 20 },
  { "canonicalName": "Condrieu", "region": "Rhône", "allowedColors": ["BLANC"], "guardMinYears": 1, "guardMaxYears": 5 },
  { "canonicalName": "Cornas", "region": "Rhône", "allowedColors": ["ROUGE"], "guardMinYears": 6, "guardMaxYears": 20 },
  { "canonicalName": "Corton-Charlemagne", "region": "Bourgogne", "allowedColors": ["BLANC"], "guardMinYears": 6, "guardMaxYears": 20 },
  { "canonicalName": "Côte-Rôtie", "region": "Rhône", "allowedColors": ["ROUGE"], "guardMinYears": 6, "guardMaxYears": 20 },
  { "canonicalName": "Côtes de Provence", "region": "Provence", "allowedColors": ["ROSE", "ROUGE", "BLANC"], "guardMinYears": 1, "guardMaxYears": 3 },
  { "canonicalName": "Côtes du Rhône", "region": "Rhône", "allowedColors": ["ROUGE", "BLANC", "ROSE"], "guardMinYears": 2, "guardMaxYears": 6 },
  { "canonicalName": "Crozes-Hermitage", "region": "Rhône", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 3, "guardMaxYears": 10 },
  { "canonicalName": "Gevrey-Chambertin", "region": "Bourgogne", "allowedColors": ["ROUGE"], "guardMinYears": 5, "guardMaxYears": 15 },
  { "canonicalName": "Gigondas", "region": "Rhône", "allowedColors": ["ROUGE", "ROSE"], "guardMinYears": 5, "guardMaxYears": 15 },
  { "canonicalName": "Hermitage", "region": "Rhône", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 8, "guardMaxYears": 25 },
  { "canonicalName": "Margaux", "region": "Bordeaux", "allowedColors": ["ROUGE"], "guardMinYears": 8, "guardMaxYears": 25 },
  { "canonicalName": "Meursault", "region": "Bourgogne", "allowedColors": ["BLANC", "ROUGE"], "guardMinYears": 3, "guardMaxYears": 12 },
  { "canonicalName": "Morey-Saint-Denis", "region": "Bourgogne", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 5, "guardMaxYears": 15 },
  { "canonicalName": "Nuits-Saint-Georges", "region": "Bourgogne", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 5, "guardMaxYears": 15 },
  { "canonicalName": "Pauillac", "region": "Bordeaux", "allowedColors": ["ROUGE"], "guardMinYears": 8, "guardMaxYears": 25 },
  { "canonicalName": "Pessac-Léognan", "region": "Bordeaux", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 5, "guardMaxYears": 20 },
  { "canonicalName": "Pomerol", "region": "Bordeaux", "allowedColors": ["ROUGE"], "guardMinYears": 6, "guardMaxYears": 20 },
  { "canonicalName": "Pommard", "region": "Bourgogne", "allowedColors": ["ROUGE"], "guardMinYears": 5, "guardMaxYears": 15 },
  { "canonicalName": "Pouilly-Fumé", "region": "Loire", "allowedColors": ["BLANC"], "guardMinYears": 1, "guardMaxYears": 5 },
  { "canonicalName": "Puligny-Montrachet", "region": "Bourgogne", "allowedColors": ["BLANC"], "guardMinYears": 3, "guardMaxYears": 12 },
  { "canonicalName": "Saint-Émilion Grand Cru", "region": "Bordeaux", "allowedColors": ["ROUGE"], "guardMinYears": 6, "guardMaxYears": 20 },
  { "canonicalName": "Saint-Estèphe", "region": "Bordeaux", "allowedColors": ["ROUGE"], "guardMinYears": 8, "guardMaxYears": 25 },
  { "canonicalName": "Saint-Joseph", "region": "Rhône", "allowedColors": ["ROUGE", "BLANC"], "guardMinYears": 3, "guardMaxYears": 10 },
  { "canonicalName": "Sancerre", "region": "Loire", "allowedColors": ["BLANC", "ROUGE", "ROSE"], "guardMinYears": 1, "guardMaxYears": 5 },
  { "canonicalName": "Sauternes", "region": "Bordeaux", "allowedColors": ["BLANC"], "guardMinYears": 5, "guardMaxYears": 30 },
  { "canonicalName": "Vosne-Romanée", "region": "Bourgogne", "allowedColors": ["ROUGE"], "guardMinYears": 5, "guardMaxYears": 20 }
]
```

- [ ] **Step 2: Write the failing service tests (DB-backed, skipped without `DATABASE_URL`)**

`api/src/appellations/appellations.service.spec.ts`:
```ts
import { PrismaClient } from '@prisma/client';
import { AppellationsService } from './appellations.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('AppellationsService.resolve', () => {
  const prisma = new PrismaClient();
  const service = new AppellationsService(prisma as any);

  beforeAll(async () => {
    await prisma.appellation.upsert({
      where: { canonicalName: 'Châteauneuf-du-Pape' },
      update: {},
      create: { canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', allowedColors: ['ROUGE', 'BLANC'] },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('aligns a close spelling silently (>= 0.8)', async () => {
    const m = await service.resolve('Chateauneuf du Pape');
    expect(m.kind).toBe('exact');
    if (m.kind !== 'none') expect(m.canonicalName).toBe('Châteauneuf-du-Pape');
  });

  it('flags a loose match (0.5–0.8) as fuzzy', async () => {
    const m = await service.resolve('Chateauneuf');
    expect(m.kind).toBe('fuzzy');
  });

  it('keeps unknown text raw (< 0.5)', async () => {
    const m = await service.resolve('Vin de table du garage');
    expect(m).toEqual({ kind: 'none', raw: 'Vin de table du garage' });
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `cd api && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave npx jest src/appellations`
Expected: FAIL — cannot find `./appellations.service`.

- [ ] **Step 4: Implement service, seed script and module**

`api/src/appellations/appellations.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { WineColor } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.service';

export type AppellationMatch =
  | { kind: 'exact' | 'fuzzy'; id: string; canonicalName: string; similarity: number }
  | { kind: 'none'; raw: string };

interface SeedRow {
  canonicalName: string;
  region: string | null;
  allowedColors: WineColor[];
  guardMinYears: number | null;
  guardMaxYears: number | null;
}

export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

@Injectable()
export class AppellationsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(raw: string): Promise<AppellationMatch> {
    const needle = normalizeLabel(raw);
    if (!needle) return { kind: 'none', raw };
    const rows = await this.prisma.$queryRaw<{ id: string; canonical_name: string; sim: number }[]>`
      SELECT id, canonical_name,
             similarity(unaccent_lower(canonical_name), ${needle}) AS sim
      FROM appellation
      ORDER BY sim DESC
      LIMIT 1`;
    const best = rows[0];
    if (!best || best.sim < 0.5) return { kind: 'none', raw };
    return {
      kind: best.sim >= 0.8 ? 'exact' : 'fuzzy',
      id: best.id,
      canonicalName: best.canonical_name,
      similarity: Number(best.sim),
    };
  }

  async seedFromFile(path: string): Promise<number> {
    const rows = JSON.parse(await readFile(path, 'utf8')) as SeedRow[];
    for (const r of rows) {
      await this.prisma.appellation.upsert({
        where: { canonicalName: r.canonicalName },
        update: { region: r.region, allowedColors: r.allowedColors, guardMinYears: r.guardMinYears, guardMaxYears: r.guardMaxYears },
        create: r,
      });
    }
    return rows.length;
  }
}
```

The query uses a small SQL helper so both sides of `similarity()` are compared accent- and case-insensitively. Add a **new migration** `api/prisma/migrations/20260921000000_unaccent_lower/migration.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION unaccent_lower(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(unaccent($1)) $$;
DROP INDEX IF EXISTS idx_appellation_name_trgm;
CREATE INDEX idx_appellation_name_trgm ON appellation USING gin (unaccent_lower(canonical_name) gin_trgm_ops);
```

`api/src/appellations/appellations.seed.ts`:
```ts
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { AppellationsService } from './appellations.service';

async function main() {
  const prisma = new PrismaClient();
  const n = await new AppellationsService(prisma as any).seedFromFile(resolve(__dirname, '../../data/appellations.json'));
  console.log(`${n} appellations chargées`);
  await prisma.$disconnect();
}

void main();
```

`api/src/appellations/appellations.module.ts`:
```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { resolve } from 'node:path';
import { AppellationsService } from './appellations.service';

@Module({ providers: [AppellationsService], exports: [AppellationsService] })
export class AppellationsModule implements OnModuleInit {
  constructor(private readonly appellations: AppellationsService) {}
  async onModuleInit() {
    // Le référentiel est chargé au démarrage de l'api (idempotent, ~360 upserts).
    await this.appellations.seedFromFile(resolve(process.cwd(), 'data/appellations.json'));
  }
}
```

Modify `api/src/app.module.ts` — add `AppellationsModule` to `imports`:
```ts
import { Module } from '@nestjs/common';
import { AppellationsModule } from './appellations/appellations.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, AuthModule, AppellationsModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 5: Apply migration, run tests**

Run: `cd api && export DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave && npx prisma migrate deploy && npx jest src/appellations`
Expected: PASS (3 tests). If « Chateauneuf » lands ≥ 0.8, lower the fuzzy fixture to `'Chateauneuf Pape'`; the thresholds themselves (0.5 / 0.8) come from the cahier des charges and must not move.

- [ ] **Step 6: Commit**

```bash
git add api/data api/prisma/migrations api/src/appellations api/src/app.module.ts
git commit -m "feat(appellations): INAO referential seed and pg_trgm fuzzy resolution"
```

---

### Task 8: Wine matching key and deduplication

**Files:**
- Create: `api/src/wines/wines.module.ts`, `api/src/wines/match-key.ts`, `api/src/wines/match-key.spec.ts`, `api/src/wines/wine-matching.service.ts`, `api/src/wines/wine-matching.service.spec.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Consumes: `AppellationsService.resolve` (Task 7), Prisma `Wine`.
- Produces: `computeMatchKey(input: WineDraft): string`; `interface WineDraft { producer: string; cuvee?: string | null; appellationRaw: string; vintage?: number | null; color: WineColor; formatCl: number }`; `WineMatchingService.matchOrCreate(draft: WineDraft): Promise<{ wine: Wine; created: boolean; appellation: AppellationMatch }>`.

- [ ] **Step 1: Failing match-key tests**

`api/src/wines/match-key.spec.ts`:
```ts
import { computeMatchKey } from './match-key';

describe('computeMatchKey', () => {
  it('normalizes case, accents, punctuation and stop words', () => {
    const a = computeMatchKey({ producer: 'Domaine Leflaive', cuvee: 'Clavoillon', appellationRaw: 'Puligny-Montrachet 1er Cru', vintage: 2019, color: 'BLANC', formatCl: 75 });
    const b = computeMatchKey({ producer: 'LEFLAIVE', cuvee: 'clavoillon', appellationRaw: 'puligny montrachet 1er cru', vintage: 2019, color: 'BLANC', formatCl: 75 });
    expect(a).toBe(b);
    expect(a).toBe('leflaive|clavoillon|puligny montrachet 1er cru|2019|BLANC|75');
  });

  it('distinguishes vintage and format', () => {
    const base = { producer: 'Château Rayas', appellationRaw: 'Châteauneuf-du-Pape', color: 'ROUGE' as const, formatCl: 75 };
    expect(computeMatchKey({ ...base, vintage: 2010 })).not.toBe(computeMatchKey({ ...base, vintage: 2011 }));
    expect(computeMatchKey({ ...base, vintage: 2010 })).not.toBe(computeMatchKey({ ...base, vintage: 2010, formatCl: 150 }));
  });

  it('encodes a missing vintage as NV', () => {
    expect(computeMatchKey({ producer: 'Krug', appellationRaw: 'Champagne', color: 'PETILLANT', formatCl: 75 })).toBe('krug||champagne|NV|PETILLANT|75');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd api && npx jest src/wines/match-key`
Expected: FAIL — cannot find `./match-key`.

- [ ] **Step 3: Implement match-key**

`api/src/wines/match-key.ts`:
```ts
import { WineColor } from '@prisma/client';
import { normalizeLabel } from '../appellations/appellations.service';

export interface WineDraft {
  producer: string;
  cuvee?: string | null;
  appellationRaw: string;
  vintage?: number | null;
  color: WineColor;
  formatCl: number;
}

const STOP_WORDS = new Set(['domaine', 'chateau', 'cuvee', 'maison', 'clos', 'les', 'le', 'la', 'de', 'du', 'des', 'd']);

export function normalizeName(s: string | null | undefined): string {
  return normalizeLabel(s ?? '')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ');
}

export function computeMatchKey(d: WineDraft): string {
  return [
    normalizeName(d.producer),
    normalizeName(d.cuvee),
    normalizeLabel(d.appellationRaw),
    d.vintage ?? 'NV',
    d.color,
    d.formatCl,
  ].join('|');
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd api && npx jest src/wines/match-key`
Expected: PASS (3 tests).

- [ ] **Step 5: Failing matching-service test (unit, fake Prisma)**

`api/src/wines/wine-matching.service.spec.ts`:
```ts
import { WineMatchingService } from './wine-matching.service';

function fakes() {
  const wines: any[] = [];
  const prisma = {
    wine: {
      findUnique: async ({ where }: any) => wines.find((w) => w.matchKey === where.matchKey) ?? null,
      create: async ({ data }: any) => {
        const w = { id: `w${wines.length + 1}`, ...data };
        wines.push(w);
        return w;
      },
    },
  };
  const appellations = {
    resolve: async (raw: string) =>
      raw.toLowerCase().includes('bandol')
        ? { kind: 'exact' as const, id: 'ap-bandol', canonicalName: 'Bandol', similarity: 0.95 }
        : { kind: 'none' as const, raw },
  };
  return { prisma, appellations, wines };
}

describe('WineMatchingService.matchOrCreate', () => {
  const draft = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'bandol aoc', vintage: 2019, color: 'ROUGE' as const, formatCl: 75 };

  it('creates a wine with the canonical appellation on first sight', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate(draft);
    expect(r.created).toBe(true);
    expect(r.wine.appellationId).toBe('ap-bandol');
    expect(r.wine.appellationRaw).toBe('Bandol');
  });

  it('returns the same wine for the same key on second sight', async () => {
    const f = fakes();
    const s = new WineMatchingService(f.prisma as any, f.appellations as any);
    const first = await s.matchOrCreate(draft);
    const second = await s.matchOrCreate({ ...draft, producer: 'TEMPIER' });
    expect(second.created).toBe(false);
    expect(second.wine.id).toBe(first.wine.id);
  });

  it('keeps the raw appellation when nothing matches', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate({ ...draft, appellationRaw: 'Vin de France' });
    expect(r.wine.appellationId).toBeNull();
    expect(r.wine.appellationRaw).toBe('Vin de France');
  });
});
```

- [ ] **Step 6: Run to see it fail, then implement**

Run: `cd api && npx jest src/wines/wine-matching`
Expected: FAIL — cannot find `./wine-matching.service`.

`api/src/wines/wine-matching.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Wine } from '@prisma/client';
import { AppellationMatch, AppellationsService } from '../appellations/appellations.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeMatchKey, WineDraft } from './match-key';

@Injectable()
export class WineMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appellations: AppellationsService,
  ) {}

  async matchOrCreate(draft: WineDraft): Promise<{ wine: Wine; created: boolean; appellation: AppellationMatch }> {
    const appellation = await this.appellations.resolve(draft.appellationRaw);
    const appellationRaw = appellation.kind === 'none' ? draft.appellationRaw.trim() : appellation.canonicalName;
    const matchKey = computeMatchKey({ ...draft, appellationRaw });

    const existing = await this.prisma.wine.findUnique({ where: { matchKey } });
    if (existing) return { wine: existing, created: false, appellation };

    const wine = await this.prisma.wine.create({
      data: {
        matchKey,
        producer: draft.producer.trim(),
        cuvee: draft.cuvee?.trim() || null,
        appellationId: appellation.kind === 'none' ? null : appellation.id,
        appellationRaw,
        vintage: draft.vintage ?? null,
        color: draft.color,
        formatCl: draft.formatCl,
      },
    });
    return { wine, created: true, appellation };
  }
}
```

`api/src/wines/wines.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AppellationsModule } from '../appellations/appellations.module';
import { WineMatchingService } from './wine-matching.service';

@Module({ imports: [AppellationsModule], providers: [WineMatchingService], exports: [WineMatchingService] })
export class WinesModule {}
```

Modify `api/src/app.module.ts` — add `WinesModule` to `imports` (keep the existing ones):
```ts
imports: [PrismaModule, AuthModule, AppellationsModule, WinesModule],
```
with `import { WinesModule } from './wines/wines.module';`.

- [ ] **Step 7: Run to see it pass, commit**

Run: `cd api && npx jest src/wines`
Expected: PASS (6 tests).

```bash
git add api/src/wines api/src/app.module.ts
git commit -m "feat(wines): normalized match key and dedup against the appellation referential"
```

---

### Task 9: Photo upload, normalization (sharp) and storage

**Files:**
- Create: `api/src/photos/photos.module.ts`, `api/src/photos/image-normalization.service.ts`, `api/src/photos/image-normalization.service.spec.ts`, `api/src/photos/photos.service.ts`, `api/src/photos/photos.service.spec.ts`, `api/src/photos/photos.controller.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Produces: `ImageNormalizationService.normalize(input: Buffer): Promise<{ buffer: Buffer; width: number; height: number }>` (auto-rotate from EXIF, max width 1600, JPEG q85, all metadata stripped); `PhotosService.ingest(input: Buffer, mimeType: string): Promise<{ photo: Photo; duplicate: boolean }>` (sha256 content hash, stores original at `<dir>/original/<id>.<ext>` and normalized at `<dir>/normalized/<id>.jpg`, creates the `Photo` row `PENDING`, returns the existing row on duplicate hash); `PhotosService.readNormalized(photoId)` → `Buffer`; `PhotosService.findById(id)`; `PhotosService.listPendingReview()` → DONE photos with no movement; route `POST /api/photos` (multipart field `file`, 202 `{ id, status, duplicate }`), `GET /api/photos/pending-review`, `GET /api/photos/:id`.
- Extraction enqueueing is added to `ingest` in Task 11 (this task leaves the photo `PENDING`).

- [ ] **Step 1: Failing normalization test**

`api/src/photos/image-normalization.service.spec.ts`:
```ts
import sharp from 'sharp';
import { ImageNormalizationService } from './image-normalization.service';

describe('ImageNormalizationService', () => {
  const service = new ImageNormalizationService();

  it('downsizes to 1600px max width, JPEG, and strips metadata', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#803030' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'test' } } })
      .toBuffer();
    const out = await service.normalize(big);
    const meta = await sharp(out.buffer).metadata();
    expect(out.width).toBe(1600);
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });

  it('does not upscale small images', async () => {
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
    const out = await service.normalize(small);
    expect(out.width).toBe(800);
  });
});
```

- [ ] **Step 2: Run to see it fail, implement**

Run: `cd api && npx jest src/photos/image-normalization`
Expected: FAIL — cannot find module.

`api/src/photos/image-normalization.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

@Injectable()
export class ImageNormalizationService {
  async normalize(input: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
    const { data, info } = await sharp(input)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  }
}
```

Run again: PASS (2 tests).

- [ ] **Step 3: Failing PhotosService test (fake Prisma, temp dir)**

`api/src/photos/photos.service.spec.ts`:
```ts
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotosService } from './photos.service';

function fakePrisma() {
  const photos: any[] = [];
  return {
    photos,
    photo: {
      findUnique: async ({ where }: any) => photos.find((p) => p.contentHash === where.contentHash || p.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const p = { id: `p${photos.length + 1}`, status: 'PENDING', createdAt: new Date(), ...data };
        photos.push(p);
        return p;
      },
      findMany: async () => photos,
    },
  };
}

describe('PhotosService.ingest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cave-photos-'));

  it('stores original + normalized and creates a PENDING row', async () => {
    const prisma = fakePrisma();
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir);
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const { photo, duplicate } = await service.ingest(img, 'image/jpeg');
    expect(duplicate).toBe(false);
    expect(photo.status).toBe('PENDING');
    expect(existsSync(join(dir, 'original', `${photo.id}.jpg`))).toBe(true);
    expect(existsSync(join(dir, 'normalized', `${photo.id}.jpg`))).toBe(true);
  });

  it('returns the existing row for the same bytes', async () => {
    const prisma = fakePrisma();
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir);
    const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#111' } }).jpeg().toBuffer();
    const a = await service.ingest(img, 'image/jpeg');
    const b = await service.ingest(img, 'image/jpeg');
    expect(b.duplicate).toBe(true);
    expect(b.photo.id).toBe(a.photo.id);
    expect(prisma.photos).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run to see it fail, implement service, controller, module**

Run: `cd api && npx jest src/photos/photos.service`
Expected: FAIL.

`api/src/photos/photos.service.ts`:
```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Photo } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { ImageNormalizationService } from './image-normalization.service';

export const PHOTO_STORAGE_DIR = 'PHOTO_STORAGE_DIR';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' };

@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalization: ImageNormalizationService,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
  ) {}

  async ingest(input: Buffer, mimeType: string): Promise<{ photo: Photo; duplicate: boolean }> {
    const contentHash = createHash('sha256').update(input).digest('hex');
    const existing = await this.prisma.photo.findUnique({ where: { contentHash } });
    if (existing) return { photo: existing, duplicate: true };

    const { buffer } = await this.normalization.normalize(input);
    const id = randomUUID();
    const ext = EXT[mimeType] ?? 'bin';
    const normalizedPath = join('normalized', `${id}.jpg`);
    await mkdir(join(this.dir, 'original'), { recursive: true });
    await mkdir(join(this.dir, 'normalized'), { recursive: true });
    await writeFile(join(this.dir, 'original', `${id}.${ext}`), input);
    await writeFile(join(this.dir, normalizedPath), buffer);

    const photo = await this.prisma.photo.create({
      data: { id, contentHash, storagePath: normalizedPath, mimeType: 'image/jpeg' },
    });
    return { photo, duplicate: false };
  }

  async findById(id: string): Promise<Photo> {
    const photo = await this.prisma.photo.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    return photo;
  }

  async readNormalized(id: string): Promise<Buffer> {
    return readFile(join(this.dir, 'normalized', `${id}.jpg`));
  }

  listPendingReview(): Promise<Photo[]> {
    return this.prisma.photo.findMany({
      where: { status: 'DONE', movements: { none: {} } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
```

Add `import { randomUUID } from 'node:crypto';` (merge with the existing `createHash` import). The id is generated before writing so the files are named after the row; the fake's `create` must therefore keep an explicit `data.id` when given — change its line to `const p = { id: data.id ?? \`p${photos.length + 1}\`, status: 'PENDING', createdAt: new Date(), ...data };`. The fake does not filter `findMany`; the real query relies on the `movements: { none: {} }` relation filter.

`api/src/photos/photos.controller.ts`:
```ts
import {
  BadRequestException, Controller, Get, HttpCode, Param, Post, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { PhotosService } from './photos.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/webp']);

@Controller('photos')
@UseGuards(AuthenticatedGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier « file » manquant');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('Format d’image non pris en charge');
    const { photo, duplicate } = await this.photos.ingest(file.buffer, file.mimetype);
    return { id: photo.id, status: photo.status, duplicate };
  }

  @Get('pending-review')
  pendingReview() {
    return this.photos.listPendingReview();
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.photos.findById(id);
  }
}
```

`api/src/photos/photos.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadEnv } from '../config/env';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotosController } from './photos.controller';
import { PHOTO_STORAGE_DIR, PhotosService } from './photos.service';

@Module({
  imports: [AuthModule],
  controllers: [PhotosController],
  providers: [
    PhotosService,
    ImageNormalizationService,
    { provide: PHOTO_STORAGE_DIR, useFactory: () => loadEnv().PHOTO_STORAGE_DIR },
  ],
  exports: [PhotosService],
})
export class PhotosModule {}
```

Modify `api/src/app.module.ts` `imports`: `[PrismaModule, AuthModule, AppellationsModule, WinesModule, PhotosModule]` with `import { PhotosModule } from './photos/photos.module';`.

- [ ] **Step 5: Run tests, manual upload, commit**

Run: `cd api && npx jest src/photos`
Expected: PASS (4 tests).

Manual (api running, logged-in cookie in `/tmp/c.txt`):
```bash
curl -s -b /tmp/c.txt -F file=@docs/design-reference/../../some-label.jpg http://localhost:3000/api/photos
```
Expected: `202 {"id":"…","status":"PENDING","duplicate":false}`; a second identical upload returns `duplicate: true` with the same id.

```bash
git add api/src/photos api/src/app.module.ts
git commit -m "feat(photos): upload, sharp normalization, content-hash dedup and local storage"
```

### Task 10: VisionProvider interface and Gemini implementation

**Files:**
- Create: `api/src/vision/vision-provider.interface.ts`, `api/src/vision/extraction-schema.ts`, `api/src/vision/extraction-schema.spec.ts`, `api/src/vision/gemini-vision.provider.ts`, `api/src/vision/gemini-vision.provider.spec.ts`, `api/src/vision/vision.module.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ExtractedField<T> { value: T | null; confidence: number }
  interface WineExtraction {
    producer: ExtractedField<string>; cuvee: ExtractedField<string>; appellation: ExtractedField<string>;
    vintage: ExtractedField<number>; color: ExtractedField<WineColor>; formatCl: ExtractedField<number>;
    degree: ExtractedField<number>; countryRegion: ExtractedField<string>; bottlesPerCase: ExtractedField<number>;
    globalConfidence: number;
  }
  interface VisionResult { extraction: WineExtraction; raw: unknown; model: string; latencyMs: number; costCents: number }
  interface VisionProvider { extractWineLabel(image: Buffer, mimeType: string): Promise<VisionResult> }
  const VISION_PROVIDER = 'VISION_PROVIDER'  // Nest injection token
  parseExtraction(raw: unknown): WineExtraction  // zod validation, throws on invalid
  ```

- [ ] **Step 1: Failing schema tests**

`api/src/vision/extraction-schema.spec.ts`:
```ts
import { parseExtraction } from './extraction-schema';

const valid = {
  producteur: { value: 'Domaine Tempier', confidence: 0.98 },
  cuvee: { value: 'La Tourtine', confidence: 0.95 },
  appellation: { value: 'Bandol', confidence: 0.97 },
  millesime: { value: 2019, confidence: 0.94 },
  couleur: { value: 'rouge', confidence: 0.99 },
  format_cl: { value: 75, confidence: 0.9 },
  degre: { value: 14.5, confidence: 0.8 },
  pays_region: { value: 'Provence', confidence: 0.7 },
  nb_cols_carton: { value: 6, confidence: 0.85 },
  confiance_globale: 0.93,
};

describe('parseExtraction', () => {
  it('maps the French JSON contract to WineExtraction', () => {
    const e = parseExtraction(valid);
    expect(e.producer.value).toBe('Domaine Tempier');
    expect(e.color.value).toBe('ROUGE');
    expect(e.bottlesPerCase.value).toBe(6);
    expect(e.globalConfidence).toBe(0.93);
  });

  it('accepts nulls (a field the model could not read) but rejects invented enum values', () => {
    expect(parseExtraction({ ...valid, millesime: { value: null, confidence: 0 } }).vintage.value).toBeNull();
    expect(() => parseExtraction({ ...valid, couleur: { value: 'orange', confidence: 0.9 } })).toThrow();
  });

  it('rejects an implausible vintage', () => {
    expect(() => parseExtraction({ ...valid, millesime: { value: 1492, confidence: 0.9 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run to see it fail, implement interface + schema**

Run: `cd api && npx jest src/vision/extraction-schema` → FAIL.

`api/src/vision/vision-provider.interface.ts`:
```ts
import { WineColor } from '@prisma/client';

export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
}

export interface WineExtraction {
  producer: ExtractedField<string>;
  cuvee: ExtractedField<string>;
  appellation: ExtractedField<string>;
  vintage: ExtractedField<number>;
  color: ExtractedField<WineColor>;
  formatCl: ExtractedField<number>;
  degree: ExtractedField<number>;
  countryRegion: ExtractedField<string>;
  bottlesPerCase: ExtractedField<number>;
  globalConfidence: number;
}

export interface VisionResult {
  extraction: WineExtraction;
  raw: unknown;
  model: string;
  latencyMs: number;
  costCents: number;
}

export interface VisionProvider {
  extractWineLabel(image: Buffer, mimeType: string): Promise<VisionResult>;
}

export const VISION_PROVIDER = 'VISION_PROVIDER';
```

`api/src/vision/extraction-schema.ts`:
```ts
import { WineColor } from '@prisma/client';
import { z } from 'zod';
import { WineExtraction } from './vision-provider.interface';

const conf = z.number().min(0).max(1);
const field = <T extends z.ZodTypeAny>(t: T) => z.object({ value: t.nullable(), confidence: conf });

const COLORS: Record<string, WineColor> = { rouge: 'ROUGE', blanc: 'BLANC', rose: 'ROSE', rosé: 'ROSE', petillant: 'PETILLANT', pétillant: 'PETILLANT', champagne: 'PETILLANT' };

export const rawExtractionSchema = z.object({
  producteur: field(z.string().min(1)),
  cuvee: field(z.string().min(1)),
  appellation: field(z.string().min(1)),
  millesime: field(z.number().int().min(1900).max(new Date().getFullYear())),
  couleur: field(z.string().transform((s, ctx) => {
    const c = COLORS[s.trim().toLowerCase()];
    if (!c) ctx.addIssue({ code: 'custom', message: `couleur inconnue: ${s}` });
    return c as WineColor;
  })),
  format_cl: field(z.number().int().positive()),
  degre: field(z.number().min(0).max(30)),
  pays_region: field(z.string().min(1)),
  nb_cols_carton: field(z.number().int().positive()),
  confiance_globale: conf,
});

export const EXTRACTION_JSON_SCHEMA_DESCRIPTION = `{
  "producteur":     {"value": string|null, "confidence": 0..1},
  "cuvee":          {"value": string|null, "confidence": 0..1},
  "appellation":    {"value": string|null, "confidence": 0..1},
  "millesime":      {"value": integer|null, "confidence": 0..1},
  "couleur":        {"value": "rouge"|"blanc"|"rosé"|"pétillant"|null, "confidence": 0..1},
  "format_cl":      {"value": integer|null, "confidence": 0..1},
  "degre":          {"value": number|null, "confidence": 0..1},
  "pays_region":    {"value": string|null, "confidence": 0..1},
  "nb_cols_carton": {"value": integer|null, "confidence": 0..1},
  "confiance_globale": 0..1
}`;

export function parseExtraction(raw: unknown): WineExtraction {
  const r = rawExtractionSchema.parse(raw);
  return {
    producer: r.producteur,
    cuvee: r.cuvee,
    appellation: r.appellation,
    vintage: r.millesime,
    color: r.couleur,
    formatCl: r.format_cl,
    degree: r.degre,
    countryRegion: r.pays_region,
    bottlesPerCase: r.nb_cols_carton,
    globalConfidence: r.confiance_globale,
  };
}
```

Run again → PASS (3 tests).

- [ ] **Step 3: Failing Gemini provider test (SDK mocked)**

`api/src/vision/gemini-vision.provider.spec.ts`:
```ts
import { GeminiVisionProvider } from './gemini-vision.provider';

const validJson = JSON.stringify({
  producteur: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: null, confidence: 0 },
  appellation: { value: 'Bandol', confidence: 0.97 }, millesime: { value: 2019, confidence: 0.94 },
  couleur: { value: 'rouge', confidence: 0.99 }, format_cl: { value: 75, confidence: 0.9 },
  degre: { value: null, confidence: 0 }, pays_region: { value: 'Provence', confidence: 0.7 },
  nb_cols_carton: { value: 6, confidence: 0.85 }, confiance_globale: 0.93,
});

function fakeModel(text: string, usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }) {
  return { generateContent: jest.fn().mockResolvedValue({ response: { text: () => text, usageMetadata: usage } }) };
}

describe('GeminiVisionProvider', () => {
  it('sends the image with the JSON contract and parses the answer', async () => {
    const model = fakeModel(validJson);
    const provider = new GeminiVisionProvider(model as any, 'gemini-test');
    const res = await provider.extractWineLabel(Buffer.from('img'), 'image/jpeg');
    expect(res.extraction.producer.value).toBe('Domaine Tempier');
    expect(res.model).toBe('gemini-test');
    expect(res.raw).toEqual(JSON.parse(validJson));
    const call = model.generateContent.mock.calls[0][0];
    expect(JSON.stringify(call)).toContain('nb_cols_carton');
    expect(call.generationConfig.responseMimeType).toBe('application/json');
  });

  it('strips a ```json fence before parsing', async () => {
    const provider = new GeminiVisionProvider(fakeModel('```json\n' + validJson + '\n```') as any, 'm');
    await expect(provider.extractWineLabel(Buffer.from('x'), 'image/jpeg')).resolves.toBeDefined();
  });

  it('throws a VisionInvalidOutputError on garbage', async () => {
    const provider = new GeminiVisionProvider(fakeModel('pas du json') as any, 'm');
    await expect(provider.extractWineLabel(Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/sortie du modèle invalide/i);
  });
});
```

- [ ] **Step 4: Run to see it fail, implement provider + module**

Run: `cd api && npx jest src/vision/gemini` → FAIL.

`api/src/vision/gemini-vision.provider.ts`:
```ts
import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import { EXTRACTION_JSON_SCHEMA_DESCRIPTION, parseExtraction } from './extraction-schema';
import { VisionProvider, VisionResult } from './vision-provider.interface';

export class VisionInvalidOutputError extends Error {}

const PROMPT = `Tu lis une étiquette de vin (ou un carton de vin) photographiée. Réponds UNIQUEMENT par un objet JSON strict de cette forme :
${EXTRACTION_JSON_SCHEMA_DESCRIPTION}
Règles :
- N'invente jamais un champ absent de l'image : un champ illisible ou absent vaut null avec confidence 0.
- Donne une confiance par champ, entre 0 et 1.
- Distingue le nom du producteur (domaine, château, maison) du nom de la cuvée.
- Sur un carton, lis le nombre de bouteilles s'il est imprimé (« 6 bouteilles », « caisse de 12 »), sinon null.
- "couleur" ∈ rouge | blanc | rosé | pétillant.
- "format_cl" en centilitres (75 par défaut uniquement si l'image le confirme, sinon null).`;

// Ordre de grandeur pour le plafond mensuel ; ajuster si la grille tarifaire change.
const PRICE_PER_1K_TOKENS_CENTS = { input: 0.01, output: 0.04 };

export class GeminiVisionProvider implements VisionProvider {
  constructor(
    private readonly model: Pick<GenerativeModel, 'generateContent'>,
    private readonly modelName: string,
  ) {}

  static fromApiKey(apiKey: string, modelName: string): GeminiVisionProvider {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
    return new GeminiVisionProvider(model, modelName);
  }

  async extractWineLabel(image: Buffer, mimeType: string): Promise<VisionResult> {
    const started = Date.now();
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { data: image.toString('base64'), mimeType } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const latencyMs = Date.now() - started;
    const text = result.response.text().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new VisionInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
    }
    let extraction;
    try {
      extraction = parseExtraction(raw);
    } catch (e) {
      throw new VisionInvalidOutputError(`Sortie du modèle invalide : ${(e as Error).message}`);
    }

    const usage = result.response.usageMetadata;
    const costCents = Math.ceil(
      ((usage?.promptTokenCount ?? 0) / 1000) * PRICE_PER_1K_TOKENS_CENTS.input +
        ((usage?.candidatesTokenCount ?? 0) / 1000) * PRICE_PER_1K_TOKENS_CENTS.output,
    );
    return { extraction, raw, model: this.modelName, latencyMs, costCents };
  }
}
```

`api/src/vision/vision.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { GeminiVisionProvider } from './gemini-vision.provider';
import { VISION_PROVIDER } from './vision-provider.interface';

@Module({
  providers: [
    {
      provide: VISION_PROVIDER,
      useFactory: () => {
        const env = loadEnv();
        return GeminiVisionProvider.fromApiKey(env.GEMINI_API_KEY, env.GEMINI_MODEL);
      },
    },
  ],
  exports: [VISION_PROVIDER],
})
export class VisionModule {}
```

- [ ] **Step 5: Run tests, commit**

Run: `cd api && npx jest src/vision` → PASS (6 tests).

```bash
git add api/src/vision
git commit -m "feat(vision): VisionProvider contract, strict JSON schema and Gemini implementation"
```

---

### Task 11: Extraction queue — BullMQ worker, monthly cost cap, SSE result push

**Files:**
- Create: `api/src/queue/extraction.queue.ts`, `api/src/queue/extraction.processor.ts`, `api/src/queue/extraction.processor.spec.ts`, `api/src/queue/queue.module.ts`, `api/src/queue/vision-budget.service.ts`, `api/src/queue/vision-budget.service.spec.ts`, `api/src/photos/photo-events.controller.ts`, `api/src/worker.ts`
- Modify: `api/src/photos/photos.service.ts` (enqueue after ingest), `api/src/photos/photos.module.ts`, `api/src/app.module.ts`

**Interfaces:**
- Consumes: `PhotosService.readNormalized`, `VISION_PROVIDER`, Prisma `Photo`.
- Produces: `EXTRACTION_QUEUE = 'photo-extraction'`, `interface ExtractionJobData { photoId: string }`, jobs are enqueued with `jobId = photoId` (BullMQ dedups on jobId); `ExtractionProcessor.process(photoId)` sets `PROCESSING` → `DONE` (`rawExtraction`, `model`, `latencyMs`, `costCents`) or `FAILED` (`errorMessage`); `VisionBudgetService.assertUnderCap()` throws `VisionBudgetExceededError` when this month's `SUM(cost_cents)` ≥ `GEMINI_MONTHLY_CAP_CENTS`; `GET /api/photos/:id/events` is an SSE stream emitting `{ status, extraction? , errorMessage? }` and closing after `DONE`/`FAILED`; the worker process (`node dist/worker.js`) runs the processor with concurrency 5 and exponential back-off (3 attempts, 2 s base) on failure.

- [ ] **Step 1: Failing budget test**

`api/src/queue/vision-budget.service.spec.ts`:
```ts
import { VisionBudgetExceededError, VisionBudgetService } from './vision-budget.service';

describe('VisionBudgetService', () => {
  const prismaWith = (sum: number | null) => ({ photo: { aggregate: async () => ({ _sum: { costCents: sum } }) } });

  it('passes when under the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(120) as any, 500).assertUnderCap()).resolves.toBeUndefined();
  });

  it('throws when the monthly sum reaches the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(500) as any, 500).assertUnderCap()).rejects.toBeInstanceOf(VisionBudgetExceededError);
  });
});
```

- [ ] **Step 2: Run to see it fail, implement**

Run: `cd api && npx jest src/queue/vision-budget` → FAIL.

`api/src/queue/vision-budget.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const VISION_MONTHLY_CAP_CENTS = 'VISION_MONTHLY_CAP_CENTS';

export class VisionBudgetExceededError extends Error {
  constructor() {
    super('Plafond mensuel de dépense vision atteint — saisie manuelle uniquement jusqu’au mois prochain');
  }
}

@Injectable()
export class VisionBudgetService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(VISION_MONTHLY_CAP_CENTS) private readonly capCents: number,
  ) {}

  async spentThisMonthCents(): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const agg = await this.prisma.photo.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start } } });
    return agg._sum.costCents ?? 0;
  }

  async assertUnderCap(): Promise<void> {
    if ((await this.spentThisMonthCents()) >= this.capCents) throw new VisionBudgetExceededError();
  }
}
```

Run → PASS (2 tests).

- [ ] **Step 3: Failing processor test**

`api/src/queue/extraction.processor.spec.ts`:
```ts
import { ExtractionProcessor } from './extraction.processor';

function harness(opts: { visionFails?: boolean } = {}) {
  const photo: any = { id: 'p1', status: 'PENDING' };
  const prisma = { photo: { update: jest.fn(async ({ data }: any) => Object.assign(photo, data)) } };
  const photos = { readNormalized: jest.fn(async () => Buffer.from('img')) };
  const vision = {
    extractWineLabel: jest.fn(async () => {
      if (opts.visionFails) throw new Error('boom');
      return { extraction: { producer: { value: 'X', confidence: 1 } }, raw: { producteur: { value: 'X', confidence: 1 } }, model: 'm', latencyMs: 12, costCents: 1 };
    }),
  };
  const budget = { assertUnderCap: jest.fn(async () => undefined) };
  return { photo, prisma, photos, vision, budget, processor: new ExtractionProcessor(prisma as any, photos as any, vision as any, budget as any) };
}

describe('ExtractionProcessor.process', () => {
  it('marks PROCESSING then DONE with the raw JSON kept verbatim', async () => {
    const h = harness();
    await h.processor.process('p1');
    expect(h.prisma.photo.update.mock.calls[0][0].data.status).toBe('PROCESSING');
    expect(h.photo.status).toBe('DONE');
    expect(h.photo.rawExtraction).toEqual({ producteur: { value: 'X', confidence: 1 } });
    expect(h.photo.costCents).toBe(1);
  });

  it('marks FAILED with the message and rethrows so BullMQ retries', async () => {
    const h = harness({ visionFails: true });
    await expect(h.processor.process('p1')).rejects.toThrow('boom');
    expect(h.photo.status).toBe('FAILED');
    expect(h.photo.errorMessage).toBe('boom');
  });

  it('checks the budget before calling the model', async () => {
    const h = harness();
    h.budget.assertUnderCap.mockRejectedValueOnce(new Error('cap'));
    await expect(h.processor.process('p1')).rejects.toThrow('cap');
    expect(h.vision.extractWineLabel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to see it fail, implement queue, processor, module, worker, SSE**

Run: `cd api && npx jest src/queue/extraction` → FAIL.

`api/src/queue/extraction.queue.ts`:
```ts
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadEnv } from '../config/env';

export const EXTRACTION_QUEUE = 'photo-extraction';
export const EXTRACTION_QUEUE_TOKEN = 'EXTRACTION_QUEUE';

export interface ExtractionJobData {
  photoId: string;
}

export function redisConnection(): Redis {
  return new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

export function createExtractionQueue(): Queue<ExtractionJobData> {
  return new Queue<ExtractionJobData>(EXTRACTION_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 1000 },
  });
}
```

`api/src/queue/extraction.processor.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PhotosService } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { VISION_PROVIDER, VisionProvider } from '../vision/vision-provider.interface';
import { VisionBudgetService } from './vision-budget.service';

@Injectable()
export class ExtractionProcessor {
  private readonly logger = new Logger(ExtractionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async process(photoId: string): Promise<void> {
    await this.prisma.photo.update({ where: { id: photoId }, data: { status: 'PROCESSING' } });
    try {
      await this.budget.assertUnderCap();
      const image = await this.photos.readNormalized(photoId);
      const result = await this.vision.extractWineLabel(image, 'image/jpeg');
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'DONE',
          rawExtraction: result.raw as Prisma.InputJsonValue,
          model: result.model,
          latencyMs: result.latencyMs,
          costCents: result.costCents,
          errorMessage: null,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Extraction ${photoId} échouée : ${message}`);
      await this.prisma.photo.update({ where: { id: photoId }, data: { status: 'FAILED', errorMessage: message } });
      throw e;
    }
  }
}
```

`api/src/queue/queue.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { PhotosModule } from '../photos/photos.module';
import { VisionModule } from '../vision/vision.module';
import { ExtractionProcessor } from './extraction.processor';
import { createExtractionQueue, EXTRACTION_QUEUE_TOKEN } from './extraction.queue';
import { VISION_MONTHLY_CAP_CENTS, VisionBudgetService } from './vision-budget.service';

@Module({
  imports: [PhotosModule, VisionModule],
  providers: [
    ExtractionProcessor,
    VisionBudgetService,
    { provide: VISION_MONTHLY_CAP_CENTS, useFactory: () => loadEnv().GEMINI_MONTHLY_CAP_CENTS },
    { provide: EXTRACTION_QUEUE_TOKEN, useFactory: createExtractionQueue },
  ],
  exports: [ExtractionProcessor, EXTRACTION_QUEUE_TOKEN, VisionBudgetService],
})
export class QueueModule {}
```

The queue instance is needed by `PhotosService` (to enqueue) **and** `PhotosService` lives in `PhotosModule` which `QueueModule` imports — to avoid a circular import, the queue provider moves into `PhotosModule`. Final wiring:

Modify `api/src/photos/photos.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadEnv } from '../config/env';
import { createExtractionQueue, EXTRACTION_QUEUE_TOKEN } from '../queue/extraction.queue';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotoEventsController } from './photo-events.controller';
import { PhotosController } from './photos.controller';
import { PHOTO_STORAGE_DIR, PhotosService } from './photos.service';

@Module({
  imports: [AuthModule],
  controllers: [PhotosController, PhotoEventsController],
  providers: [
    PhotosService,
    ImageNormalizationService,
    { provide: PHOTO_STORAGE_DIR, useFactory: () => loadEnv().PHOTO_STORAGE_DIR },
    { provide: EXTRACTION_QUEUE_TOKEN, useFactory: createExtractionQueue },
  ],
  exports: [PhotosService, EXTRACTION_QUEUE_TOKEN],
})
export class PhotosModule {}
```
and remove the `EXTRACTION_QUEUE_TOKEN` provider/export from `QueueModule` (keep the rest).

Modify `api/src/photos/photos.service.ts` — inject the queue and enqueue on a fresh ingest:
```ts
// imports to add
import { Queue } from 'bullmq';
import { EXTRACTION_QUEUE_TOKEN, ExtractionJobData } from '../queue/extraction.queue';

// constructor becomes
constructor(
  private readonly prisma: PrismaService,
  private readonly normalization: ImageNormalizationService,
  @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
  @Inject(EXTRACTION_QUEUE_TOKEN) private readonly queue: Pick<Queue<ExtractionJobData>, 'add'>,
) {}

// at the end of ingest(), before `return { photo, duplicate: false };`
await this.queue.add('extract', { photoId: photo.id }, { jobId: photo.id });
```
Update the two `PhotosService` tests from Task 9 to pass a fake queue as 4th argument: `const queue = { add: jest.fn() };` and `new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any)`; add to the first test `expect(queue.add).toHaveBeenCalledWith('extract', { photoId: photo.id }, { jobId: photo.id });` and to the duplicate test `expect(queue.add).toHaveBeenCalledTimes(1);`.

`api/src/photos/photo-events.controller.ts`:
```ts
import { Controller, Param, Sse, UseGuards } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { Observable } from 'rxjs';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { EXTRACTION_QUEUE, redisConnection } from '../queue/extraction.queue';
import { parseExtraction } from '../vision/extraction-schema';
import { PhotosService } from './photos.service';

interface PhotoEvent {
  data: { status: string; extraction?: unknown; errorMessage?: string | null };
}

@Controller('photos')
@UseGuards(AuthenticatedGuard)
export class PhotoEventsController {
  private readonly events = new QueueEvents(EXTRACTION_QUEUE, { connection: redisConnection() });

  constructor(private readonly photos: PhotosService) {}

  @Sse(':id/events')
  stream(@Param('id') id: string): Observable<PhotoEvent> {
    return new Observable((subscriber) => {
      const emit = async () => {
        const photo = await this.photos.findById(id);
        const data: PhotoEvent['data'] = { status: photo.status, errorMessage: photo.errorMessage };
        if (photo.status === 'DONE' && photo.rawExtraction) data.extraction = parseExtraction(photo.rawExtraction);
        subscriber.next({ data });
        if (photo.status === 'DONE' || photo.status === 'FAILED') subscriber.complete();
      };
      const onDone = ({ jobId }: { jobId: string }) => { if (jobId === id) void emit(); };
      this.events.on('completed', onDone);
      this.events.on('failed', onDone);
      void emit();
      return () => {
        this.events.off('completed', onDone);
        this.events.off('failed', onDone);
      };
    });
  }
}
```

`api/src/worker.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { ExtractionProcessor } from './queue/extraction.processor';
import { EXTRACTION_QUEUE, ExtractionJobData, redisConnection } from './queue/extraction.queue';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const processor = app.get(ExtractionProcessor);
  const worker = new Worker<ExtractionJobData>(EXTRACTION_QUEUE, (job) => processor.process(job.data.photoId), {
    connection: redisConnection(),
    concurrency: 5,
  });
  worker.on('failed', (job, err) => console.warn(`job ${job?.id} failed: ${err.message}`));
  console.log('worker prêt (photo-extraction, concurrence 5)');
  const stop = async () => { await worker.close(); await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
```

Modify `api/src/app.module.ts` `imports`: `[PrismaModule, AuthModule, AppellationsModule, WinesModule, PhotosModule, QueueModule]` with `import { QueueModule } from './queue/queue.module';`.

- [ ] **Step 5: Run all api tests, then an end-to-end extraction**

Run: `cd api && npx jest` → PASS (all suites; the Task 9 tests updated for the queue argument).

Manual (Postgres, Redis, a real `GEMINI_API_KEY` in `.env`; api via `npm run start:dev`, worker via `npm run start:worker:dev`):
```bash
curl -s -b /tmp/c.txt -F file=@/path/to/etiquette.jpg http://localhost:3000/api/photos
curl -N -b /tmp/c.txt http://localhost:3000/api/photos/<id>/events
```
Expected: SSE lines `data: {"status":"PENDING"}` … `data: {"status":"DONE","extraction":{…}}` within ~2–8 s; `GET /api/photos/<id>` shows `rawExtraction`, `model`, `latencyMs`, `costCents`.

- [ ] **Step 6: Commit**

```bash
git add api/src/queue api/src/photos api/src/worker.ts api/src/app.module.ts
git commit -m "feat(queue): BullMQ extraction worker with monthly vision cap and SSE result stream"
```

### Task 12: Movements — confirmed IN movements, idempotency, cancellation, recent history

**Files:**
- Create: `api/src/movements/movements.module.ts`, `api/src/movements/movements.service.ts`, `api/src/movements/movements.service.spec.ts`, `api/src/movements/movements.controller.ts`, `api/src/movements/dto.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Consumes: `WineMatchingService.matchOrCreate` (Task 8), Prisma `Movement`, `stock_courant`.
- Produces:
  ```ts
  interface CreateMovementInput {
    idempotencyKey: string;           // uuid généré côté client
    photoId?: string | null;
    wine: WineDraft;                  // Task 8
    quantity: number;                 // > 0, nombre de bouteilles rentrées
    priceUnitCents?: number | null;
    note?: string | null;
  }
  interface MovementResult { movement: Movement; wine: Wine; stock: number; created: boolean }
  MovementsService.createIn(input): Promise<MovementResult>           // created=false si idempotencyKey déjà vue
  MovementsService.cancel(movementId: string, idempotencyKey: string): Promise<MovementResult>  // mouvement inverse
  MovementsService.recent(limit = 20): Promise<Array<Movement & { wine: Wine }>>
  MovementsService.stockOf(wineId): Promise<number>
  ```
  Routes: `POST /api/movements`, `POST /api/movements/bulk` (array; per-item result `{ ok, result? , error? }`), `POST /api/movements/:id/cancel` `{ idempotencyKey }`, `GET /api/movements/recent?limit=20`.

- [ ] **Step 1: Failing service tests (unit, fake Prisma with a real-ish stock sum)**

`api/src/movements/movements.service.spec.ts`:
```ts
import { ConflictException } from '@nestjs/common';
import { MovementsService } from './movements.service';

function harness() {
  const movements: any[] = [];
  const wine = { id: 'w1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
  const stock = () => movements.filter((m) => m.wineId === 'w1').reduce((s, m) => s + m.delta, 0);
  const prisma = {
    movement: {
      findUnique: async ({ where, include }: any) => {
        const m = movements.find((x) => x.idempotencyKey === where.idempotencyKey || x.id === where.id) ?? null;
        return m && include?.wine ? { ...m, wine } : m;
      },
      create: async ({ data, include }: any) => {
        if (stock() + data.delta < 0) throw new Error('il ne reste aucune bouteille de ce vin');
        const m = { id: `m${movements.length + 1}`, occurredAt: new Date(), ...data };
        movements.push(m);
        return include?.wine ? { ...m, wine } : m;
      },
      findMany: async ({ take }: any) => [...movements].reverse().slice(0, take).map((m) => ({ ...m, wine })),
    },
    $queryRaw: async () => [{ quantity: stock() }],
  };
  const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
  return { movements, service: new MovementsService(prisma as any, matching as any) };
}

const input = {
  idempotencyKey: 'k1',
  wine: { producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75, vintage: 2019 },
  quantity: 6,
};

describe('MovementsService', () => {
  it('creates a positive IN movement and returns the new stock', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    expect(r.created).toBe(true);
    expect(r.movement.delta).toBe(6);
    expect(r.movement.type).toBe('IN');
    expect(r.stock).toBe(6);
  });

  it('is idempotent on idempotencyKey', async () => {
    const h = harness();
    await h.service.createIn(input);
    const again = await h.service.createIn({ ...input, quantity: 99 });
    expect(again.created).toBe(false);
    expect(h.movements).toHaveLength(1);
  });

  it('rejects a non-positive quantity', async () => {
    const h = harness();
    await expect(h.service.createIn({ ...input, quantity: 0 })).rejects.toThrow(/quantité/i);
  });

  it('cancels by writing the inverse movement, never deleting', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    const c = await h.service.cancel(r.movement.id, 'cancel-1');
    expect(c.movement.delta).toBe(-6);
    expect(c.movement.type).toBe('ADJUST');
    expect(c.movement.reversesId).toBe(r.movement.id);
    expect(c.stock).toBe(0);
    expect(h.movements).toHaveLength(2);
  });

  it('refuses to cancel twice', async () => {
    const h = harness();
    const r = await h.service.createIn(input);
    await h.service.cancel(r.movement.id, 'cancel-1');
    await expect(h.service.cancel(r.movement.id, 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
  });
});
```

- [ ] **Step 2: Run to see it fail, implement**

Run: `cd api && npx jest src/movements` → FAIL.

`api/src/movements/dto.ts`:
```ts
import { z } from 'zod';

export const wineDraftSchema = z.object({
  producer: z.string().trim().min(1, 'Producteur requis'),
  cuvee: z.string().trim().nullish(),
  appellationRaw: z.string().trim().min(1, 'Appellation requise'),
  vintage: z.number().int().min(1900).max(new Date().getFullYear()).nullish(),
  color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']),
  formatCl: z.number().int().positive().default(75),
});

export const createMovementSchema = z.object({
  idempotencyKey: z.string().uuid(),
  photoId: z.string().uuid().nullish(),
  wine: wineDraftSchema,
  quantity: z.number().int().positive('La quantité doit être positive'),
  priceUnitCents: z.number().int().nonnegative().nullish(),
  note: z.string().trim().max(500).nullish(),
});

export type CreateMovementInput = z.infer<typeof createMovementSchema>;
```

`api/src/movements/movements.service.ts`:
```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Movement, Wine } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WineMatchingService } from '../wines/wine-matching.service';
import { CreateMovementInput } from './dto';

export interface MovementResult {
  movement: Movement;
  wine: Wine;
  stock: number;
  created: boolean;
}

@Injectable()
export class MovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: WineMatchingService,
  ) {}

  async stockOf(wineId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock_courant WHERE wine_id = ${wineId}::uuid`;
    return rows[0]?.quantity ?? 0;
  }

  async createIn(input: CreateMovementInput): Promise<MovementResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité doit être un entier positif');
    }
    const existing = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } });
    if (existing) return { movement: existing, wine: existing.wine, stock: await this.stockOf(existing.wineId), created: false };

    const { wine } = await this.matching.matchOrCreate(input.wine);
    const movement = await this.prisma.movement.create({
      data: {
        wineId: wine.id,
        delta: input.quantity,
        type: 'IN',
        photoId: input.photoId ?? null,
        priceUnitCents: input.priceUnitCents ?? null,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { movement, wine, stock: await this.stockOf(wine.id), created: true };
  }

  async cancel(movementId: string, idempotencyKey: string): Promise<MovementResult> {
    const already = await this.prisma.movement.findUnique({ where: { idempotencyKey }, include: { wine: true } });
    if (already) return { movement: already, wine: already.wine, stock: await this.stockOf(already.wineId), created: false };

    const original = await this.prisma.movement.findUnique({ where: { id: movementId }, include: { wine: true } });
    if (!original) throw new NotFoundException('Mouvement introuvable');
    const reversal = await this.prisma.movement.findFirst({ where: { reversesId: movementId } });
    if (reversal) throw new ConflictException('Ce mouvement a déjà été annulé');

    try {
      const movement = await this.prisma.movement.create({
        data: {
          wineId: original.wineId,
          delta: -original.delta,
          type: 'ADJUST',
          note: `Annulation du mouvement ${original.id}`,
          idempotencyKey,
          reversesId: original.id,
        },
      });
      return { movement, wine: original.wine, stock: await this.stockOf(original.wineId), created: true };
    } catch (e) {
      if (e instanceof Error && /aucune bouteille/.test(e.message)) {
        throw new ConflictException('Impossible d’annuler : il ne reste aucune bouteille de ce vin');
      }
      throw e;
    }
  }

  recent(limit = 20): Promise<Array<Movement & { wine: Wine }>> {
    return this.prisma.movement.findMany({ take: limit, orderBy: { occurredAt: 'desc' }, include: { wine: true } });
  }
}
```

Add `findFirst: async ({ where }: any) => movements.find((m) => m.reversesId === where.reversesId) ?? null,` to the fake in the spec.

`api/src/movements/movements.controller.ts`:
```ts
import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { createMovementSchema } from './dto';
import { MovementsService } from './movements.service';

@Controller('movements')
@UseGuards(AuthenticatedGuard)
export class MovementsController {
  constructor(private readonly movements: MovementsService) {}

  @Post()
  create(@Body() body: unknown) {
    const parsed = createMovementSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.createIn(parsed.data);
  }

  @Post('bulk')
  async bulk(@Body() body: unknown) {
    const parsed = z.array(createMovementSchema).min(1).max(200).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Liste de mouvements invalide');
    const results = [];
    for (const item of parsed.data) {
      try {
        results.push({ ok: true as const, idempotencyKey: item.idempotencyKey, result: await this.movements.createIn(item) });
      } catch (e) {
        results.push({ ok: false as const, idempotencyKey: item.idempotencyKey, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { idempotencyKey?: string }) {
    if (!body?.idempotencyKey) throw new BadRequestException('idempotencyKey requis');
    return this.movements.cancel(id, body.idempotencyKey);
  }

  @Get('recent')
  recent(@Query('limit') limit?: string) {
    return this.movements.recent(Math.min(Number(limit ?? 20) || 20, 100));
  }
}
```

`api/src/movements/movements.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WinesModule } from '../wines/wines.module';
import { MovementsController } from './movements.controller';
import { MovementsService } from './movements.service';

@Module({ imports: [AuthModule, WinesModule], controllers: [MovementsController], providers: [MovementsService], exports: [MovementsService] })
export class MovementsModule {}
```

Modify `api/src/app.module.ts` `imports`: add `MovementsModule` (`import { MovementsModule } from './movements/movements.module';`).

- [ ] **Step 3: Run tests, manual round-trip, commit**

Run: `cd api && npx jest src/movements` → PASS (5 tests).

Manual:
```bash
KEY=$(uuidgen | tr A-Z a-z)
curl -s -b /tmp/c.txt -H 'Content-Type: application/json' -d "{\"idempotencyKey\":\"$KEY\",\"wine\":{\"producer\":\"Domaine Tempier\",\"cuvee\":\"La Tourtine\",\"appellationRaw\":\"Bandol\",\"vintage\":2019,\"color\":\"ROUGE\",\"formatCl\":75},\"quantity\":12}" http://localhost:3000/api/movements
```
Expected: `{ "movement": {...,"delta":12}, "wine": {...,"appellationRaw":"Bandol"}, "stock": 12, "created": true }`; replaying the same body returns `created: false` and still `stock: 12`; `GET /api/movements/recent` lists it.

```bash
git add api/src/movements api/src/app.module.ts
git commit -m "feat(movements): confirmed IN movements with idempotency, inverse-movement cancel and history"
```

---

### Task 13: Excel export (ExcelJS) — Stock, Mouvements, Référence

**Files:**
- Create: `api/src/export/export.module.ts`, `api/src/export/export.service.ts`, `api/src/export/export.service.spec.ts`, `api/src/export/export.controller.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Produces: `interface ExportFilter { color?: WineColor; region?: string }`; `ExportService.buildWorkbook(filter, userId): Promise<{ buffer: Buffer; rowCount: number }>` — sheet `Stock` (one row per wine with `quantity > 0`: Producteur, Cuvée, Appellation, Région, Millésime, Couleur, Format (cl), Quantité, Prix d'achat unitaire (€), Valeur d'achat (€)), sheet `Mouvements` (Date, Type, Delta, Producteur, Cuvée, Appellation, Millésime, Prix unitaire, Note — newest first), sheet `Référence` (Appellation, Région, Couleurs, Garde min, Garde max); frozen header rows, auto-filter, column widths; writes an `export_log` row. Route `GET /api/export.xlsx?color=&region=` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="cave-YYYY-MM-DD.xlsx"`.

- [ ] **Step 1: Failing service test (reads the workbook back with ExcelJS)**

`api/src/export/export.service.spec.ts`:
```ts
import ExcelJS from 'exceljs';
import { ExportService } from './export.service';

function fakePrisma() {
  const wines = [
    { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, appellation: { region: 'Provence' } },
    { id: 'w2', producer: 'Leflaive', cuvee: null, appellationRaw: 'Puligny-Montrachet', vintage: 2020, color: 'BLANC', formatCl: 75, appellation: { region: 'Bourgogne' } },
  ];
  const movements = [
    { id: 'm1', wineId: 'w1', delta: 12, type: 'IN', occurredAt: new Date('2026-09-01'), priceUnitCents: 4800, note: null, wine: wines[0] },
    { id: 'm2', wineId: 'w2', delta: 6, type: 'IN', occurredAt: new Date('2026-09-02'), priceUnitCents: null, note: null, wine: wines[1] },
    { id: 'm3', wineId: 'w2', delta: -6, type: 'ADJUST', occurredAt: new Date('2026-09-03'), priceUnitCents: null, note: 'Annulation', wine: wines[1] },
  ];
  return {
    $queryRaw: async () => [{ wine_id: 'w1', quantity: 12 }, { wine_id: 'w2', quantity: 0 }],
    wine: { findMany: async () => wines },
    movement: { findMany: async () => [...movements].reverse() },
    appellation: { findMany: async () => [{ canonicalName: 'Bandol', region: 'Provence', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 5, guardMaxYears: 20 }] },
    exportLog: { create: jest.fn(async ({ data }: any) => data) },
  };
}

describe('ExportService.buildWorkbook', () => {
  it('writes three sheets and only wines in stock on Stock', async () => {
    const prisma = fakePrisma();
    const { buffer, rowCount } = await new ExportService(prisma as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Stock', 'Mouvements', 'Référence']);
    const stock = wb.getWorksheet('Stock')!;
    expect(stock.rowCount).toBe(2); // header + Tempier
    expect(stock.getRow(2).getCell(1).value).toBe('Domaine Tempier');
    expect(stock.getRow(2).getCell(8).value).toBe(12);
    expect(stock.getRow(2).getCell(10).value).toBe(576); // 12 × 48 €
    expect(rowCount).toBe(1);
    expect(wb.getWorksheet('Mouvements')!.rowCount).toBe(4);
    expect(prisma.exportLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', rowCount: 1 }) }));
  });

  it('filters Stock by colour', async () => {
    const prisma = fakePrisma();
    const { rowCount } = await new ExportService(prisma as any).buildWorkbook({ color: 'BLANC' }, 'u1');
    expect(rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to see it fail, implement**

Run: `cd api && npx jest src/export` → FAIL.

`api/src/export/export.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { WineColor } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';

export interface ExportFilter {
  color?: WineColor;
  region?: string;
}

const COLOR_LABEL: Record<WineColor, string> = { ROUGE: 'Rouge', BLANC: 'Blanc', ROSE: 'Rosé', PETILLANT: 'Pétillant' };

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async buildWorkbook(filter: ExportFilter, userId: string): Promise<{ buffer: Buffer; rowCount: number }> {
    const [stockRows, wines, movements, appellations] = await Promise.all([
      this.prisma.$queryRaw<{ wine_id: string; quantity: number }[]>`SELECT wine_id, quantity FROM stock_courant`,
      this.prisma.wine.findMany({ include: { appellation: true }, orderBy: [{ producer: 'asc' }, { vintage: 'asc' }] }),
      this.prisma.movement.findMany({ include: { wine: true }, orderBy: { occurredAt: 'desc' } }),
      this.prisma.appellation.findMany({ orderBy: { canonicalName: 'asc' } }),
    ]);
    const stockByWine = new Map(stockRows.map((r) => [r.wine_id, Number(r.quantity)]));
    const lastPrice = new Map<string, number>();
    for (const m of [...movements].reverse()) if (m.priceUnitCents != null) lastPrice.set(m.wineId, m.priceUnitCents);

    const inStock = wines.filter((w) => {
      const q = stockByWine.get(w.id) ?? 0;
      if (q <= 0) return false;
      if (filter.color && w.color !== filter.color) return false;
      if (filter.region && (w.appellation?.region ?? '').toLowerCase() !== filter.region.toLowerCase()) return false;
      return true;
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Cave & Terroir';
    wb.created = new Date();

    const stock = wb.addWorksheet('Stock', { views: [{ state: 'frozen', ySplit: 1 }] });
    stock.columns = [
      { header: 'Producteur', key: 'producer', width: 28 },
      { header: 'Cuvée', key: 'cuvee', width: 22 },
      { header: 'Appellation', key: 'appellation', width: 26 },
      { header: 'Région', key: 'region', width: 14 },
      { header: 'Millésime', key: 'vintage', width: 10 },
      { header: 'Couleur', key: 'color', width: 10 },
      { header: 'Format (cl)', key: 'formatCl', width: 10 },
      { header: 'Quantité', key: 'quantity', width: 10 },
      { header: "Prix d'achat unitaire (€)", key: 'price', width: 20 },
      { header: "Valeur d'achat (€)", key: 'value', width: 16 },
    ];
    for (const w of inStock) {
      const q = stockByWine.get(w.id) ?? 0;
      const price = lastPrice.has(w.id) ? lastPrice.get(w.id)! / 100 : null;
      stock.addRow({
        producer: w.producer, cuvee: w.cuvee ?? '', appellation: w.appellationRaw, region: w.appellation?.region ?? '',
        vintage: w.vintage ?? 'NV', color: COLOR_LABEL[w.color], formatCl: w.formatCl, quantity: q,
        price, value: price == null ? null : Math.round(price * q * 100) / 100,
      });
    }
    stock.autoFilter = { from: 'A1', to: 'J1' };
    stock.getRow(1).font = { bold: true };

    const mv = wb.addWorksheet('Mouvements', { views: [{ state: 'frozen', ySplit: 1 }] });
    mv.columns = [
      { header: 'Date', key: 'date', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
      { header: 'Type', key: 'type', width: 8 },
      { header: 'Delta', key: 'delta', width: 8 },
      { header: 'Producteur', key: 'producer', width: 28 },
      { header: 'Cuvée', key: 'cuvee', width: 22 },
      { header: 'Appellation', key: 'appellation', width: 26 },
      { header: 'Millésime', key: 'vintage', width: 10 },
      { header: 'Prix unitaire (€)', key: 'price', width: 16 },
      { header: 'Note', key: 'note', width: 40 },
    ];
    for (const m of movements) {
      mv.addRow({
        date: m.occurredAt, type: m.type, delta: m.delta, producer: m.wine.producer, cuvee: m.wine.cuvee ?? '',
        appellation: m.wine.appellationRaw, vintage: m.wine.vintage ?? 'NV',
        price: m.priceUnitCents == null ? null : m.priceUnitCents / 100, note: m.note ?? '',
      });
    }
    mv.autoFilter = { from: 'A1', to: 'I1' };
    mv.getRow(1).font = { bold: true };

    const ref = wb.addWorksheet('Référence', { views: [{ state: 'frozen', ySplit: 1 }] });
    ref.columns = [
      { header: 'Appellation', key: 'name', width: 30 },
      { header: 'Région', key: 'region', width: 16 },
      { header: 'Couleurs', key: 'colors', width: 22 },
      { header: 'Garde min (ans)', key: 'gmin', width: 14 },
      { header: 'Garde max (ans)', key: 'gmax', width: 14 },
    ];
    for (const a of appellations) {
      ref.addRow({ name: a.canonicalName, region: a.region ?? '', colors: a.allowedColors.map((c) => COLOR_LABEL[c]).join(', '), gmin: a.guardMinYears, gmax: a.guardMaxYears });
    }
    ref.getRow(1).font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    await this.prisma.exportLog.create({ data: { userId, filter: filter as object, rowCount: inStock.length } });
    return { buffer, rowCount: inStock.length };
  }
}
```

`api/src/export/export.controller.ts`:
```ts
import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { AppUser, WineColor } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExportService } from './export.service';

const COLORS = new Set<string>(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']);

@Controller('export.xlsx')
@UseGuards(AuthenticatedGuard)
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @Get()
  async download(@Query('color') color: string | undefined, @Query('region') region: string | undefined, @CurrentUser() user: AppUser, @Res() res: Response) {
    if (color && !COLORS.has(color)) throw new BadRequestException('Couleur inconnue');
    const { buffer } = await this.exporter.buildWorkbook({ color: color as WineColor | undefined, region: region || undefined }, user.id);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cave-${date}.xlsx"`);
    res.send(buffer);
  }
}
```

`api/src/export/export.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

@Module({ imports: [AuthModule], controllers: [ExportController], providers: [ExportService] })
export class ExportModule {}
```

Modify `api/src/app.module.ts` — final `imports` for Lot 1:
```ts
imports: [PrismaModule, AuthModule, AppellationsModule, WinesModule, PhotosModule, QueueModule, MovementsModule, ExportModule],
```

- [ ] **Step 3: Run tests, manual download, commit**

Run: `cd api && npx jest` → PASS (all suites).

Manual: `curl -s -b /tmp/c.txt -o /tmp/cave.xlsx -D - http://localhost:3000/api/export.xlsx` → `Content-Disposition: attachment; filename="cave-2026-09-20.xlsx"`; open `/tmp/cave.xlsx`: three sheets, frozen headers, the Tempier row with quantity 12.

```bash
git add api/src/export api/src/app.module.ts
git commit -m "feat(export): on-demand Excel workbook (Stock, Mouvements, Référence)"
```

### Task 14: Design tokens (JSON → CSS variables) and base components

**Files:**
- Create: `web/src/design-tokens/tokens.json`, `web/scripts/build-tokens.mjs` (replace the Task 1 stub), `web/scripts/build-tokens.test.mjs`, `web/src/styles/base.css`, `web/src/components/Button.tsx`, `web/src/components/QuantityPicker.tsx`, `web/src/components/QuantityPicker.test.tsx`, `web/src/components/ConfidenceBadge.tsx`, `web/src/components/EditableField.tsx`, `web/src/components/EditableField.test.tsx`
- Modify: `web/src/main.tsx` (import `./styles/base.css` after tokens), `web/package.json` (`"test": "npm run tokens && node --test scripts && vitest run"`)

**Interfaces:**
- Produces: CSS custom properties `--color-primary`, `--color-primary-action`, `--color-primary-action-hover`, `--color-primary-container`, `--color-ferronnerie`, `--color-background`, `--color-surface`, `--color-surface-lowest`, `--color-surface-container`, `--color-surface-container-low`, `--color-surface-container-high`, `--color-outline-variant`, `--color-secondary`, `--color-on-surface`, `--color-error`, `--color-warning`, `--color-warning-container`, `--color-success`, `--font-serif`, `--font-sans`, `--space-xs/sm/md/lg/xl`, `--radius-sm/md/lg/xl`, `--touch-target`, `--header-height`, `--bottomnav-height`, `--safe-bottom`; classes `.btn`, `.btn--primary` (primary.action), `.btn--dark` (ferronnerie), `.btn--outline`, `.btn--link`, `.action`, `.action--in`, `.action--out`, `.topbar`, `.bottomnav`, `.page`, `.card`; components `Button`, `QuantityPicker({ value, onChange, detected? })` (pills 1 · 6 · 12 · 18 · Autre), `ConfidenceBadge({ confidence })`, `EditableField({ label, value, confidence, onChange, serif?, type? })`.

- [ ] **Step 1: tokens.json (single source of truth — values from the spec's consolidated palette)**

`web/src/design-tokens/tokens.json`:
```json
{
  "color": {
    "primary": { "$value": "#7A5522" },
    "primary-action": { "$value": "#8B612C", "$description": "Fond des boutons texte, ~5,5:1 en blanc" },
    "primary-action-hover": { "$value": "#6B491D" },
    "primary-container": { "$value": "#A37943", "$description": "Doré chêne : badges, aplats sans texte" },
    "primary-fixed": { "$value": "#FFDDB7" },
    "ferronnerie": { "$value": "#2B2621", "$description": "Sortir, validation, dock d'action" },
    "ferronnerie-hover": { "$value": "#3D3730" },
    "background": { "$value": "#FCF9F3" },
    "surface": { "$value": "#FCF9F3" },
    "surface-lowest": { "$value": "#FFFFFF" },
    "surface-container": { "$value": "#F0EEE8" },
    "surface-container-low": { "$value": "#F6F3ED" },
    "surface-container-high": { "$value": "#EBE8E2" },
    "outline-variant": { "$value": "#D3C4B5" },
    "outline-subtle": { "$value": "#E6DFD3" },
    "secondary": { "$value": "#635D5A", "$description": "Texte atténué ; jamais pour une donnée utile en 11 px" },
    "on-surface": { "$value": "#1C1C18" },
    "on-primary": { "$value": "#FFFFFF" },
    "error": { "$value": "#BA1A1A" },
    "error-container": { "$value": "#FFDAD6" },
    "warning": { "$value": "#B4653A", "$description": "Aplat seulement : champs à faible confiance, file hors ligne" },
    "warning-container": { "$value": "#FCE2D0" },
    "success": { "$value": "#4B6459" },
    "wine-rouge": { "$value": "#5C2423" },
    "wine-blanc": { "$value": "#E6C77A" },
    "wine-rose": { "$value": "#E8A598" }
  },
  "font": {
    "serif": { "$value": "'Noto Serif', Georgia, serif" },
    "sans": { "$value": "'Manrope', system-ui, sans-serif" }
  },
  "space": { "xs": { "$value": "4px" }, "sm": { "$value": "8px" }, "md": { "$value": "16px" }, "lg": { "$value": "24px" }, "xl": { "$value": "40px" } },
  "radius": { "sm": { "$value": "4px" }, "md": { "$value": "8px" }, "lg": { "$value": "12px" }, "xl": { "$value": "16px" } },
  "size": {
    "touch-target": { "$value": "48px" },
    "header-height": { "$value": "56px" },
    "bottomnav-height": { "$value": "64px" },
    "action-height": { "$value": "56px" }
  },
  "motion": {
    "fast": { "$value": "150ms" },
    "base": { "$value": "200ms" },
    "ease": { "$value": "cubic-bezier(0.4, 0, 0.2, 1)" }
  }
}
```

- [ ] **Step 2: Failing generator test (Node test runner)**

`web/scripts/build-tokens.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensToCss } from './build-tokens.mjs';

test('flattens groups into --group-name custom properties', () => {
  const css = tokensToCss({ color: { primary: { $value: '#7A5522' }, 'primary-action': { $value: '#8B612C' } }, space: { md: { $value: '16px' } } });
  assert.match(css, /--color-primary: #7A5522;/);
  assert.match(css, /--color-primary-action: #8B612C;/);
  assert.match(css, /--space-md: 16px;/);
  assert.match(css, /^:root \{/);
});
```

- [ ] **Step 3: Run to see it fail, implement generator**

Run: `cd web && node --test scripts` → FAIL (`tokensToCss` is not exported).

`web/scripts/build-tokens.mjs`:
```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function tokensToCss(tokens) {
  const lines = [];
  for (const [group, entries] of Object.entries(tokens)) {
    for (const [name, token] of Object.entries(entries)) {
      lines.push(`  --${group}-${name}: ${token.$value};`);
    }
  }
  return `:root {\n${lines.join('\n')}\n  --safe-bottom: env(safe-area-inset-bottom, 0px);\n  --safe-top: env(safe-area-inset-top, 0px);\n}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tokens = JSON.parse(readFileSync(join(root, 'src/design-tokens/tokens.json'), 'utf8'));
  mkdirSync(join(root, 'src/design-tokens'), { recursive: true });
  writeFileSync(join(root, 'src/design-tokens/tokens.css'), '/* Généré depuis tokens.json — ne pas éditer */\n' + tokensToCss(tokens));
}
```

Run: `cd web && node --test scripts && npm run tokens` → PASS, `src/design-tokens/tokens.css` generated.

- [ ] **Step 4: Base stylesheet (only `var(--…)` values)**

`web/src/styles/base.css`:
```css
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--color-background); color: var(--color-on-surface);
  font-family: var(--font-sans); font-size: 16px; line-height: 1.5; -webkit-tap-highlight-color: transparent;
  padding-bottom: calc(var(--size-bottomnav-height) + var(--safe-bottom));
}
h1, h2, h3, .serif { font-family: var(--font-serif); font-weight: 500; margin: 0; }
.num { font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
.material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; vertical-align: middle; }
.centered { text-align: center; padding: var(--space-xl) var(--space-md); color: var(--color-secondary); }
.text-error { color: var(--color-error); }

.page { max-width: 640px; margin: 0 auto; padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-md); }
.card { background: var(--color-surface-lowest); border: 1px solid var(--color-outline-subtle); border-radius: var(--radius-xl); padding: var(--space-md); }

.topbar {
  position: sticky; top: 0; z-index: 40; height: calc(var(--size-header-height) + var(--safe-top)); padding-top: var(--safe-top);
  display: flex; align-items: center; gap: var(--space-sm); padding-inline: var(--space-md);
  background: color-mix(in srgb, var(--color-surface) 95%, transparent); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--color-outline-subtle);
}
.topbar__title { font-size: 20px; color: var(--color-primary); }
.topbar__logo, .topbar__back { color: var(--color-primary); display: inline-flex; width: var(--size-touch-target); height: var(--size-touch-target); align-items: center; justify-content: center; }

.bottomnav {
  position: fixed; inset-inline: 0; bottom: 0; z-index: 50; height: calc(var(--size-bottomnav-height) + var(--safe-bottom)); padding-bottom: var(--safe-bottom);
  display: flex; justify-content: space-around; align-items: center;
  background: color-mix(in srgb, var(--color-surface) 95%, transparent); backdrop-filter: blur(8px); border-top: 1px solid var(--color-outline-subtle);
}
.bottomnav__tab { flex: 1; min-height: var(--size-touch-target); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 11px; letter-spacing: 0.06em; text-decoration: none; color: var(--color-secondary); }
.bottomnav__tab--active { color: var(--color-primary); font-weight: 600; }
.bottomnav__tab--soon { opacity: 0.45; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-sm);
  min-height: var(--size-touch-target); padding: 0 var(--space-lg); border-radius: var(--radius-lg); border: 1px solid transparent;
  font: 600 15px var(--font-sans); text-decoration: none; cursor: pointer; transition: transform var(--motion-fast) var(--motion-ease), background var(--motion-fast) var(--motion-ease);
}
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--primary { background: var(--color-primary-action); color: var(--color-on-primary); }
.btn--primary:hover { background: var(--color-primary-action-hover); }
.btn--dark { background: var(--color-ferronnerie); color: var(--color-surface); width: 100%; min-height: var(--size-action-height); border-radius: var(--radius-xl); }
.btn--dark:hover { background: var(--color-ferronnerie-hover); }
.btn--outline { background: transparent; border-color: var(--color-outline-variant); color: var(--color-primary); }
.btn--link { background: transparent; color: var(--color-secondary); text-decoration: underline; text-underline-offset: 4px; }
.btn:focus-visible, .action:focus-visible, .pill:focus-visible { outline: 3px solid var(--color-primary-container); outline-offset: 2px; }

.actions { display: flex; flex-direction: column; gap: var(--space-sm); }
.action {
  display: flex; align-items: center; gap: var(--space-md); width: 100%; min-height: 72px; padding: var(--space-md);
  border-radius: var(--radius-lg); border: 1px solid transparent; text-align: left; text-decoration: none; font-family: var(--font-sans); cursor: pointer;
}
.action--in { background: var(--color-primary-action); color: var(--color-on-primary); }
.action--out { background: var(--color-ferronnerie); color: var(--color-surface); }
.action:disabled { opacity: 0.55; cursor: not-allowed; }
.action__text { flex: 1; display: flex; flex-direction: column; }
.action__text strong { font-size: 15px; letter-spacing: 0.02em; }
.action__text small { font-size: 12px; opacity: 0.85; }

.login { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-md); padding: var(--space-md); }
.login__logo { font-size: 48px; color: var(--color-primary); }
.login__title { font-size: 28px; color: var(--color-primary); }
.login__form { display: flex; flex-direction: column; gap: var(--space-sm); width: min(100%, 360px); }
.login__form label { display: flex; flex-direction: column; gap: var(--space-xs); font-size: 14px; color: var(--color-secondary); }
input, select { min-height: var(--size-touch-target); padding: 0 var(--space-md); border: 1px solid var(--color-outline-variant); border-radius: var(--radius-md); background: var(--color-surface-lowest); font: 400 16px var(--font-sans); color: var(--color-on-surface); }

.pills { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; padding: 6px; background: var(--color-surface-container); border: 1px solid var(--color-outline-subtle); border-radius: var(--radius-xl); }
.pill { min-height: 52px; border-radius: var(--radius-lg); border: 1px solid var(--color-outline-subtle); background: var(--color-surface-lowest); font: 600 18px var(--font-sans); color: var(--color-on-surface); display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; }
.pill small { font-size: 9px; font-weight: 400; color: var(--color-secondary); }
.pill--active { background: var(--color-primary-container); color: var(--color-on-primary); border-color: var(--color-primary-container); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary-container) 30%, transparent); }
.pill--active small { color: var(--color-primary-fixed); }

.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font: 600 11px var(--font-sans); letter-spacing: 0.04em; }
.badge--ok { background: color-mix(in srgb, var(--color-primary-fixed) 60%, transparent); color: var(--color-primary); }
.badge--warn { background: var(--color-warning-container); color: var(--color-warning); }
.badge--error { background: var(--color-error-container); color: var(--color-error); }

.field { display: flex; flex-direction: column; gap: var(--space-xs); padding-block: var(--space-sm); border-bottom: 1px solid var(--color-outline-subtle); }
.field__label { display: flex; align-items: center; gap: var(--space-sm); font-size: 12px; letter-spacing: 0.08em; color: var(--color-secondary); }
.field--low { background: var(--color-warning-container); margin-inline: calc(-1 * var(--space-md)); padding-inline: var(--space-md); border-radius: var(--radius-md); }
.field input, .field select { font-size: 18px; }
.field--serif input { font-family: var(--font-serif); }

.dock { position: fixed; inset-inline: 0; bottom: calc(var(--size-bottomnav-height) + var(--safe-bottom)); z-index: 45; padding: var(--space-sm) var(--space-md); background: color-mix(in srgb, var(--color-surface) 92%, transparent); backdrop-filter: blur(12px); border-top: 1px solid var(--color-outline-subtle); }
.dock__hint { display: block; text-align: center; font-size: 11px; color: var(--color-secondary); margin-top: var(--space-xs); }

.banner { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-lg); border: 1px solid var(--color-outline-subtle); background: var(--color-surface-container-low); font-size: 13px; }
.banner--warn { border-color: var(--color-warning); }
.banner .btn { margin-left: auto; min-height: 36px; padding-inline: var(--space-md); font-size: 12px; }

.list { display: flex; flex-direction: column; background: var(--color-surface-lowest); border: 1px solid var(--color-outline-subtle); border-radius: var(--radius-xl); overflow: hidden; }
.list__row { display: flex; align-items: center; gap: var(--space-md); padding: var(--space-md); border-bottom: 1px solid var(--color-outline-subtle); }
.list__row:last-child { border-bottom: 0; }
.list__delta { font: 700 12px var(--font-sans); }
.list__delta--in { color: var(--color-primary-action); }
.list__delta--out { color: var(--color-secondary); }
.list__title { font-family: var(--font-serif); font-size: 16px; color: var(--color-primary); }
.list__meta { font-size: 11px; color: var(--color-secondary); }

.capture { display: flex; flex-direction: column; align-items: center; gap: var(--space-lg); padding-top: var(--space-xl); }
.capture__input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.preview { width: 100%; max-height: 220px; object-fit: cover; border-radius: var(--radius-lg); background: var(--color-surface-container); }
.progress { height: 6px; border-radius: 999px; background: var(--color-surface-container-high); overflow: hidden; }
.progress > span { display: block; height: 100%; width: 40%; background: var(--color-primary-container); animation: slide 1.2s var(--motion-ease) infinite; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
```

Modify `web/src/main.tsx` imports: `import './design-tokens/tokens.css'; import './styles/base.css';`.

- [ ] **Step 5: Failing component tests**

`web/src/components/QuantityPicker.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuantityPicker } from './QuantityPicker';

it('offers 1/6/12/18 and a free value, preselecting the detected quantity', async () => {
  const onChange = vi.fn();
  render(<QuantityPicker value={6} detected={6} onChange={onChange} />);
  expect(screen.getByRole('button', { name: /^6/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Détecté sur carton : 6/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^12/ }));
  expect(onChange).toHaveBeenCalledWith(12);
  await userEvent.click(screen.getByRole('button', { name: /Autre/ }));
  await userEvent.clear(screen.getByRole('spinbutton', { name: /Quantité libre/ }));
  await userEvent.type(screen.getByRole('spinbutton', { name: /Quantité libre/ }), '3');
  expect(onChange).toHaveBeenLastCalledWith(3);
});
```

`web/src/components/EditableField.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditableField } from './EditableField';

it('highlights low confidence and forwards edits', async () => {
  const onChange = vi.fn();
  const { container } = render(<EditableField label="Millésime" value="2019" confidence={0.42} onChange={onChange} type="number" />);
  expect(container.querySelector('.field--low')).not.toBeNull();
  expect(screen.getByText('42 %')).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('Millésime'));
  await userEvent.type(screen.getByLabelText('Millésime'), '2020');
  expect(onChange).toHaveBeenLastCalledWith('2020');
});
```

- [ ] **Step 6: Run to see them fail, implement components**

Run: `cd web && npx vitest run src/components` → FAIL.

`web/src/components/Button.tsx`:
```tsx
import { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'dark' | 'outline' | 'link';

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" {...props} className={`btn btn--${variant} ${className}`.trim()} />;
}
```

`web/src/components/ConfidenceBadge.tsx`:
```tsx
export const LOW_CONFIDENCE = 0.7;

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const cls = confidence >= LOW_CONFIDENCE ? 'badge--ok' : 'badge--warn';
  return (
    <span className={`badge ${cls}`} aria-label={`Confiance ${pct} %`}>
      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{confidence >= LOW_CONFIDENCE ? 'verified' : 'help'}</span>
      {pct} %
    </span>
  );
}
```

`web/src/components/EditableField.tsx`:
```tsx
import { useId } from 'react';
import { ConfidenceBadge, LOW_CONFIDENCE } from './ConfidenceBadge';

interface Props {
  label: string;
  value: string;
  confidence?: number;
  onChange: (value: string) => void;
  serif?: boolean;
  type?: 'text' | 'number';
  options?: { value: string; label: string }[];
}

export function EditableField({ label, value, confidence, onChange, serif, type = 'text', options }: Props) {
  const id = useId();
  const low = confidence !== undefined && confidence < LOW_CONFIDENCE;
  return (
    <div className={`field${low ? ' field--low' : ''}${serif ? ' field--serif' : ''}`}>
      <label htmlFor={id} className="field__label">
        {label}
        {confidence !== undefined && <ConfidenceBadge confidence={confidence} />}
      </label>
      {options ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input id={id} type={type} inputMode={type === 'number' ? 'numeric' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
```

`web/src/components/QuantityPicker.tsx`:
```tsx
import { useState } from 'react';

const PRESETS = [
  { n: 1, label: 'btl' },
  { n: 6, label: 'Carton' },
  { n: 12, label: 'Caisse' },
  { n: 18, label: 'Lot' },
];

export function QuantityPicker({ value, detected, onChange }: { value: number; detected?: number | null; onChange: (n: number) => void }) {
  const [free, setFree] = useState(!PRESETS.some((p) => p.n === value));
  return (
    <section className="card" aria-label="Quantité à intégrer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong className="num">Quantité à intégrer</strong>
        {detected ? <span className="badge badge--ok">Détecté sur carton : {detected}</span> : null}
      </div>
      <div className="pills">
        {PRESETS.map((p) => (
          <button key={p.n} type="button" className={`pill${!free && value === p.n ? ' pill--active' : ''}`} aria-pressed={!free && value === p.n} onClick={() => { setFree(false); onChange(p.n); }}>
            {p.n}
            <small>{p.label}</small>
          </button>
        ))}
        <button type="button" className={`pill${free ? ' pill--active' : ''}`} aria-pressed={free} onClick={() => setFree(true)}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>
          <small>Autre</small>
        </button>
      </div>
      {free && (
        <label style={{ display: 'block', marginTop: 8 }}>
          <span className="field__label">Quantité libre</span>
          <input type="number" min={1} inputMode="numeric" aria-label="Quantité libre" value={value} onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Run, commit**

Run: `cd web && npm test` → PASS (all).

```bash
git add web
git commit -m "feat(web): Cave & Terroir design tokens, base styles and confirmation-screen components"
```

---

### Task 15: Entry flow — capture, wait for extraction, confirm, write the IN movement

**Files:**
- Create: `web/src/lib/sse.ts`, `web/src/lib/api-client.ts` (extend), `web/src/lib/extraction-to-draft.ts`, `web/src/lib/extraction-to-draft.test.ts`, `web/src/pages/EntreeCapturePage.tsx`, `web/src/pages/EntreeConfirmationPage.tsx`, `web/src/pages/EntreeConfirmationPage.test.tsx`
- Modify: `web/src/router.tsx`

**Interfaces:**
- Consumes: `POST /api/photos`, `GET /api/photos/:id/events` (SSE), `GET /api/photos/:id`, `POST /api/movements` (Tasks 9, 11, 12).
- Produces (api-client additions):
  ```ts
  type WineColor = 'ROUGE' | 'BLANC' | 'ROSE' | 'PETILLANT';
  interface ExtractedField<T> { value: T | null; confidence: number }
  interface WineExtraction { producer, cuvee, appellation: ExtractedField<string>; vintage, formatCl, bottlesPerCase: ExtractedField<number>; color: ExtractedField<WineColor>; globalConfidence: number }
  interface PhotoDto { id: string; status: 'PENDING'|'PROCESSING'|'DONE'|'FAILED'; rawExtraction?: unknown; errorMessage?: string | null; createdAt: string }
  interface WineDraft { producer: string; cuvee?: string | null; appellationRaw: string; vintage?: number | null; color: WineColor; formatCl: number }
  interface CreateMovementInput { idempotencyKey: string; photoId?: string | null; wine: WineDraft; quantity: number; priceUnitCents?: number | null; note?: string | null }
  interface MovementResult { movement: { id: string; delta: number; type: string; occurredAt: string }; wine: WineDraft & { id: string }; stock: number; created: boolean }
  uploadPhoto(file: File | Blob): Promise<{ id: string; status: string; duplicate: boolean }>
  getPhoto(id): Promise<PhotoDto>
  createMovement(input): Promise<MovementResult>
  ```
  `subscribePhotoEvents(photoId, onEvent: (e: { status; extraction?: WineExtraction; errorMessage? }) => void): () => void`;
  `extractionToDraft(e: WineExtraction): { draft: WineDraft; confidences: Record<keyof WineDraft, number>; detectedQuantity: number | null }`;
  routes `/entree` (capture) and `/entree/:photoId` (confirmation).

- [ ] **Step 1: Failing extraction-to-draft test**

`web/src/lib/extraction-to-draft.test.ts`:
```ts
import { extractionToDraft } from './extraction-to-draft';

const e = {
  producer: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: null, confidence: 0 },
  appellation: { value: 'Bandol', confidence: 0.97 }, vintage: { value: 2019, confidence: 0.6 },
  color: { value: 'ROUGE' as const, confidence: 0.99 }, formatCl: { value: null, confidence: 0 },
  bottlesPerCase: { value: 6, confidence: 0.85 }, globalConfidence: 0.9,
};

it('builds an editable draft with defaults and per-field confidences', () => {
  const { draft, confidences, detectedQuantity } = extractionToDraft(e);
  expect(draft).toEqual({ producer: 'Domaine Tempier', cuvee: '', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75 });
  expect(confidences.vintage).toBe(0.6);
  expect(confidences.formatCl).toBe(0);
  expect(detectedQuantity).toBe(6);
});
```

- [ ] **Step 2: Run to see it fail, implement lib files**

Run: `cd web && npx vitest run src/lib/extraction` → FAIL.

`web/src/lib/extraction-to-draft.ts`:
```ts
import type { WineDraft, WineExtraction } from './api-client';

export function extractionToDraft(e: WineExtraction) {
  const draft: WineDraft = {
    producer: e.producer.value ?? '',
    cuvee: e.cuvee.value ?? '',
    appellationRaw: e.appellation.value ?? '',
    vintage: e.vintage.value,
    color: e.color.value ?? 'ROUGE',
    formatCl: e.formatCl.value ?? 75,
  };
  const confidences: Record<keyof WineDraft, number> = {
    producer: e.producer.confidence, cuvee: e.cuvee.confidence, appellationRaw: e.appellation.confidence,
    vintage: e.vintage.confidence, color: e.color.confidence, formatCl: e.formatCl.confidence,
  };
  return { draft, confidences, detectedQuantity: e.bottlesPerCase.value };
}
```

Append to `web/src/lib/api-client.ts`:
```ts
export type WineColor = 'ROUGE' | 'BLANC' | 'ROSE' | 'PETILLANT';
export interface ExtractedField<T> { value: T | null; confidence: number }
export interface WineExtraction {
  producer: ExtractedField<string>; cuvee: ExtractedField<string>; appellation: ExtractedField<string>;
  vintage: ExtractedField<number>; color: ExtractedField<WineColor>; formatCl: ExtractedField<number>;
  bottlesPerCase: ExtractedField<number>; globalConfidence: number;
}
export interface PhotoDto { id: string; status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED'; rawExtraction?: unknown; errorMessage?: string | null; createdAt: string }
export interface WineDraft { producer: string; cuvee?: string | null; appellationRaw: string; vintage?: number | null; color: WineColor; formatCl: number }
export interface CreateMovementInput { idempotencyKey: string; photoId?: string | null; wine: WineDraft; quantity: number; priceUnitCents?: number | null; note?: string | null }
export interface MovementResult { movement: { id: string; delta: number; type: string; occurredAt: string }; wine: WineDraft & { id: string }; stock: number; created: boolean }
export interface PhotoEvent { status: PhotoDto['status']; extraction?: WineExtraction; errorMessage?: string | null }

export function uploadPhoto(file: File | Blob) {
  const form = new FormData();
  form.append('file', file, 'photo.jpg');
  return apiFetch<{ id: string; status: string; duplicate: boolean }>('/photos', { method: 'POST', body: form });
}
export const getPhoto = (id: string) => apiFetch<PhotoDto>(`/photos/${id}`);
export const createMovement = (input: CreateMovementInput) =>
  apiFetch<MovementResult>('/movements', { method: 'POST', body: JSON.stringify(input) });
```

`web/src/lib/sse.ts`:
```ts
import type { PhotoEvent } from './api-client';

export function subscribePhotoEvents(photoId: string, onEvent: (e: PhotoEvent) => void, onError?: () => void): () => void {
  const source = new EventSource(`/api/photos/${photoId}/events`, { withCredentials: true });
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data) as PhotoEvent;
    onEvent(e);
    if (e.status === 'DONE' || e.status === 'FAILED') source.close();
  };
  source.onerror = () => { source.close(); onError?.(); };
  return () => source.close();
}
```

Run: `cd web && npx vitest run src/lib` → PASS.

- [ ] **Step 3: Failing confirmation-page test**

`web/src/pages/EntreeConfirmationPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import * as sse from '../lib/sse';
import { EntreeConfirmationPage } from './EntreeConfirmationPage';

const extraction: api.WineExtraction = {
  producer: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: 'La Tourtine', confidence: 0.95 },
  appellation: { value: 'Bandol', confidence: 0.97 }, vintage: { value: 2019, confidence: 0.5 },
  color: { value: 'ROUGE', confidence: 0.99 }, formatCl: { value: 75, confidence: 0.9 },
  bottlesPerCase: { value: 6, confidence: 0.85 }, globalConfidence: 0.93,
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/entree/p1']}>
        <Routes>
          <Route path="/entree/:photoId" element={<EntreeConfirmationPage />} />
          <Route path="/" element={<p>Accueil</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('waits for extraction, prefills the form, then writes one IN movement on confirm', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'PENDING', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation((_id, onEvent) => { onEvent({ status: 'DONE', extraction }); return () => {}; });
  const create = vi.spyOn(api, 'createMovement').mockResolvedValue({ movement: { id: 'm1', delta: 6, type: 'IN', occurredAt: '' }, wine: { id: 'w1', producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 6, created: true });

  mount();
  expect(await screen.findByDisplayValue('Domaine Tempier')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^6/ })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(screen.getByRole('button', { name: /Confirmer l’entrée \(\+6 bouteilles\)/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const input = create.mock.calls[0][0];
  expect(input.quantity).toBe(6);
  expect(input.photoId).toBe('p1');
  expect(input.wine.producer).toBe('Domaine Tempier');
  expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText(/Stock : 6/)).toBeInTheDocument();
});

it('shows the failure and a manual-entry fallback when extraction fails', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'FAILED', errorMessage: 'Plafond mensuel atteint', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  mount();
  expect(await screen.findByText(/Plafond mensuel atteint/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Saisir à la main/ })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run to see it fail, implement the two pages and routes**

Run: `cd web && npx vitest run src/pages/EntreeConfirmation` → FAIL.

`web/src/pages/EntreeCapturePage.tsx`:
```tsx
import { ChangeEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { TopBar } from '../components/TopBar';
import { uploadPhoto } from '../lib/api-client';

export function EntreeCapturePage() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await uploadPhoto(file);
      navigate(`/entree/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  return (
    <>
      <TopBar title="Rentrer du vin" back="/" />
      <main className="page capture">
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>
          Photographiez le carton (mentions imprimées) ou l’étiquette d’une bouteille.
        </p>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Prendre une photo" />
        <Button variant="primary" onClick={() => input.current?.click()} disabled={busy} style={{ width: '100%', minHeight: 'var(--size-action-height)' }}>
          <span className="material-symbols-outlined">photo_camera</span>
          {busy ? 'Envoi…' : 'Prendre la photo'}
        </Button>
        {error && <p role="alert" className="text-error">{error}</p>}
      </main>
    </>
  );
}
```

`web/src/pages/EntreeConfirmationPage.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { EditableField } from '../components/EditableField';
import { QuantityPicker } from '../components/QuantityPicker';
import { TopBar } from '../components/TopBar';
import { createMovement, getPhoto, MovementResult, PhotoEvent, WineDraft, WineExtraction } from '../lib/api-client';
import { extractionToDraft } from '../lib/extraction-to-draft';
import { subscribePhotoEvents } from '../lib/sse';

const COLORS = [
  { value: 'ROUGE', label: 'Rouge' }, { value: 'BLANC', label: 'Blanc' }, { value: 'ROSE', label: 'Rosé' }, { value: 'PETILLANT', label: 'Pétillant' },
];

const EMPTY: WineDraft = { producer: '', cuvee: '', appellationRaw: '', vintage: null, color: 'ROUGE', formatCl: 75 };

export function EntreeConfirmationPage() {
  const { photoId = '' } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<PhotoEvent['status']>('PENDING');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<WineExtraction | null>(null);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<WineDraft>(EMPTY);
  const [confidences, setConfidences] = useState<Partial<Record<keyof WineDraft, number>>>({});
  const [quantity, setQuantity] = useState(1);
  const [detected, setDetected] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [result, setResult] = useState<MovementResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    let unsub = () => {};
    void getPhoto(photoId).then((p) => {
      setStatus(p.status);
      setErrorMessage(p.errorMessage ?? null);
      if (p.status === 'DONE' || p.status === 'FAILED') return;
      unsub = subscribePhotoEvents(photoId, (e) => {
        setStatus(e.status);
        setErrorMessage(e.errorMessage ?? null);
        if (e.extraction) setExtraction(e.extraction);
      });
    });
    return () => unsub();
  }, [photoId]);

  useEffect(() => {
    if (!extraction) return;
    const { draft: d, confidences: c, detectedQuantity } = extractionToDraft(extraction);
    setDraft(d);
    setConfidences(c);
    setDetected(detectedQuantity);
    if (detectedQuantity) setQuantity(detectedQuantity);
  }, [extraction]);

  async function confirm() {
    setSubmitError(null);
    try {
      const r = await createMovement({
        idempotencyKey,
        photoId,
        wine: { ...draft, cuvee: draft.cuvee || null, vintage: draft.vintage ?? null },
        quantity,
        priceUnitCents: price ? Math.round(Number(price.replace(',', '.')) * 100) : null,
      });
      setResult(r);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Écriture impossible');
    }
  }

  if (result) {
    return (
      <>
        <TopBar title="Entrée enregistrée" />
        <main className="page">
          <section className="card">
            <h2>{result.wine.producer}</h2>
            <p className="num">+{result.movement.delta} bouteilles · Stock : {result.stock}</p>
          </section>
          <Button variant="dark" onClick={() => navigate('/entree')}>Rentrer un autre vin</Button>
          <Button variant="outline" onClick={() => navigate('/')}>Retour à l’accueil</Button>
        </main>
      </>
    );
  }

  const waiting = !manual && (status === 'PENDING' || status === 'PROCESSING');
  const failed = !manual && status === 'FAILED';

  return (
    <>
      <TopBar title="Nouvelle entrée" back="/entree" />
      <main className="page" style={{ paddingBottom: 140 }}>
        <img className="preview" src={`/api/photos/${photoId}/image`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        {waiting && (
          <section className="card">
            <p>Analyse de l’étiquette en cours…</p>
            <div className="progress"><span /></div>
          </section>
        )}
        {failed && (
          <section className="card" role="alert">
            <p className="text-error">Lecture impossible : {errorMessage ?? 'erreur inconnue'}</p>
            <Button variant="outline" onClick={() => setManual(true)}>Saisir à la main</Button>
          </section>
        )}
        {(status === 'DONE' || manual) && (
          <>
            <section className="card">
              <EditableField label="Producteur" serif value={draft.producer} confidence={confidences.producer} onChange={(v) => setDraft({ ...draft, producer: v })} />
              <EditableField label="Cuvée" serif value={draft.cuvee ?? ''} confidence={confidences.cuvee} onChange={(v) => setDraft({ ...draft, cuvee: v })} />
              <EditableField label="Appellation" serif value={draft.appellationRaw} confidence={confidences.appellationRaw} onChange={(v) => setDraft({ ...draft, appellationRaw: v })} />
              <EditableField label="Millésime" type="number" value={draft.vintage?.toString() ?? ''} confidence={confidences.vintage} onChange={(v) => setDraft({ ...draft, vintage: v ? Number(v) : null })} />
              <EditableField label="Couleur" value={draft.color} confidence={confidences.color} options={COLORS} onChange={(v) => setDraft({ ...draft, color: v as WineDraft['color'] })} />
              <EditableField label="Format (cl)" type="number" value={String(draft.formatCl)} confidence={confidences.formatCl} onChange={(v) => setDraft({ ...draft, formatCl: Number(v) || 75 })} />
            </section>
            <QuantityPicker value={quantity} detected={detected} onChange={setQuantity} />
            <details className="card">
              <summary>Détails optionnels</summary>
              <EditableField label="Prix d’achat unitaire (€)" type="number" value={price} onChange={setPrice} />
            </details>
            {submitError && <p role="alert" className="text-error">{submitError}</p>}
            <div className="dock">
              <Button variant="dark" onClick={confirm} disabled={!draft.producer || !draft.appellationRaw}>
                <span className="material-symbols-outlined">check_circle</span>
                Confirmer l’entrée (+{quantity} bouteille{quantity > 1 ? 's' : ''})
              </Button>
              <span className="dock__hint">Écrit un mouvement IN · annulable depuis le journal</span>
            </div>
          </>
        )}
      </main>
    </>
  );
}
```

The `<img src="/api/photos/:id/image">` needs a small api route — add to `api/src/photos/photos.controller.ts`:
```ts
@Get(':id/image')
async image(@Param('id') id: string, @Res() res: Response) {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(await this.photos.readNormalized(id));
}
```
with `import { Res } from '@nestjs/common'` and `import { Response } from 'express'` added to that file.

Modify `web/src/router.tsx` children:
```tsx
children: [
  { path: '/', element: <HomePage /> },
  { path: '/entree', element: <EntreeCapturePage /> },
  { path: '/entree/:photoId', element: <EntreeConfirmationPage /> },
],
```
with the two imports.

- [ ] **Step 5: Run web tests, then the golden path in the browser**

Run: `cd web && npm test` → PASS.

Manual (api + worker + web dev servers, real Gemini key): Home → *Rentrer du vin* → pick a label photo → confirmation appears in < 10 s with fields prefilled, vintage highlighted if low confidence, quantity 6 preselected on a carton photo → *Confirmer l’entrée (+6 bouteilles)* → « Stock : 6 ». `GET /api/export.xlsx` shows the wine. Double-tapping *Confirmer* creates a single movement (idempotency key).

- [ ] **Step 6: Commit**

```bash
git add web api/src/photos/photos.controller.ts
git commit -m "feat(web): photo capture, live extraction wait and confirmed stock-entry screen"
```

### Task 16: Offline queue — IndexedDB, foreground flush, always-visible counter

**Files:**
- Create: `web/src/lib/offline-queue.ts`, `web/src/lib/offline-queue.test.ts`, `web/src/lib/use-offline-queue.ts`, `web/src/components/OfflineQueueBanner.tsx`
- Modify: `web/src/pages/EntreeCapturePage.tsx` (queue when offline or upload fails with a network error), `web/src/pages/HomePage.tsx` (render the banner), `web/src/App.tsx` (start the flusher)

**Interfaces:**
- Produces:
  ```ts
  interface QueuedPhoto { id: string; blob: Blob; bytes: number; createdAt: number; mode: 'single' | 'campaign' }
  const QUEUE_LIMITS = { maxItems: 20, maxBytes: 50 * 1024 * 1024 }
  class QueueFullError extends Error
  enqueuePhoto(blob: Blob, mode): Promise<QueuedPhoto>      // throws QueueFullError over the limits
  listQueue(): Promise<QueuedPhoto[]>
  removeFromQueue(id): Promise<void>
  queueStats(): Promise<{ count: number; bytes: number }>
  flushQueue(upload: (blob: Blob) => Promise<unknown>): Promise<{ sent: number; failed: number }>   // stops at first network failure, keeps the rest
  useOfflineQueue(): { count: number; bytes: number; flushing: boolean; flushNow(): void }        // React hook; flushes on mount, on `online`, on `visibilitychange` → visible, and every 60 s while open
  <OfflineQueueBanner />  // « N photo(s) en attente » + bouton « Forcer l’envoi », rendered only when count > 0
  ```

- [ ] **Step 1: Failing queue tests (fake-indexeddb is loaded by `test-setup.ts`)**

`web/src/lib/offline-queue.test.ts`:
```ts
import { enqueuePhoto, flushQueue, listQueue, queueStats, QueueFullError, _resetForTests } from './offline-queue';

const blob = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

beforeEach(() => _resetForTests());

it('stores photos and reports stats', async () => {
  await enqueuePhoto(blob(10), 'single');
  await enqueuePhoto(blob(20), 'campaign');
  expect(await queueStats()).toEqual({ count: 2, bytes: 30 });
  expect((await listQueue()).map((p) => p.mode)).toEqual(['single', 'campaign']);
});

it('refuses beyond 20 items or 50 MB', async () => {
  for (let i = 0; i < 20; i++) await enqueuePhoto(blob(1), 'single');
  await expect(enqueuePhoto(blob(1), 'single')).rejects.toBeInstanceOf(QueueFullError);
  await _resetForTests();
  await expect(enqueuePhoto(blob(50 * 1024 * 1024 + 1), 'single')).rejects.toBeInstanceOf(QueueFullError);
});

it('flushes in order, removes sent items and stops at the first failure', async () => {
  await enqueuePhoto(blob(1), 'single');
  await enqueuePhoto(blob(2), 'single');
  await enqueuePhoto(blob(3), 'single');
  const upload = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({});
  const r = await flushQueue(upload);
  expect(r).toEqual({ sent: 1, failed: 1 });
  expect((await queueStats()).count).toBe(2);
});
```

- [ ] **Step 2: Run to see it fail, implement queue + hook + banner**

Run: `cd web && npx vitest run src/lib/offline-queue` → FAIL.

`web/src/lib/offline-queue.ts`:
```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface QueuedPhoto {
  id: string;
  blob: Blob;
  bytes: number;
  createdAt: number;
  mode: 'single' | 'campaign';
}

interface CaveDB extends DBSchema {
  photos: { key: string; value: QueuedPhoto; indexes: { byCreated: number } };
}

export const QUEUE_LIMITS = { maxItems: 20, maxBytes: 50 * 1024 * 1024 };

export class QueueFullError extends Error {
  constructor() {
    super('File hors ligne pleine (20 photos / 50 Mo) — envoyez les photos en attente avant d’en prendre d’autres');
  }
}

let dbPromise: Promise<IDBPDatabase<CaveDB>> | null = null;

function db() {
  dbPromise ??= openDB<CaveDB>('cave-offline', 1, {
    upgrade(d) {
      const store = d.createObjectStore('photos', { keyPath: 'id' });
      store.createIndex('byCreated', 'createdAt');
    },
  });
  return dbPromise;
}

export async function listQueue(): Promise<QueuedPhoto[]> {
  return (await db()).getAllFromIndex('photos', 'byCreated');
}

export async function queueStats(): Promise<{ count: number; bytes: number }> {
  const all = await listQueue();
  return { count: all.length, bytes: all.reduce((s, p) => s + p.bytes, 0) };
}

export async function enqueuePhoto(blob: Blob, mode: QueuedPhoto['mode']): Promise<QueuedPhoto> {
  const { count, bytes } = await queueStats();
  if (count >= QUEUE_LIMITS.maxItems || bytes + blob.size > QUEUE_LIMITS.maxBytes) throw new QueueFullError();
  const item: QueuedPhoto = { id: crypto.randomUUID(), blob, bytes: blob.size, createdAt: Date.now(), mode };
  await (await db()).put('photos', item);
  return item;
}

export async function removeFromQueue(id: string): Promise<void> {
  await (await db()).delete('photos', id);
}

export async function flushQueue(upload: (blob: Blob) => Promise<unknown>): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  for (const item of await listQueue()) {
    try {
      await upload(item.blob);
      await removeFromQueue(item.id);
      sent++;
    } catch {
      return { sent, failed: 1 };
    }
  }
  return { sent, failed: 0 };
}

export async function _resetForTests(): Promise<void> {
  await (await db()).clear('photos');
}
```

`web/src/lib/use-offline-queue.ts`:
```ts
import { useCallback, useEffect, useState } from 'react';
import { uploadPhoto } from './api-client';
import { flushQueue, queueStats } from './offline-queue';

const listeners = new Set<() => void>();
export function notifyQueueChanged() {
  listeners.forEach((l) => l());
}

export function useOfflineQueue() {
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [flushing, setFlushing] = useState(false);

  const refresh = useCallback(() => void queueStats().then(setStats), []);

  const flushNow = useCallback(async () => {
    if (flushing || !navigator.onLine) return;
    setFlushing(true);
    try {
      await flushQueue(uploadPhoto);
    } finally {
      setFlushing(false);
      notifyQueueChanged();
    }
  }, [flushing]);

  useEffect(() => {
    refresh();
    listeners.add(refresh);
    const onVisible = () => { if (document.visibilityState === 'visible') void flushNow(); };
    window.addEventListener('online', flushNow);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(flushNow, 60_000);
    void flushNow();
    return () => {
      listeners.delete(refresh);
      window.removeEventListener('online', flushNow);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [refresh, flushNow]);

  return { ...stats, flushing, flushNow };
}
```

`web/src/components/OfflineQueueBanner.tsx`:
```tsx
import { useOfflineQueue } from '../lib/use-offline-queue';
import { Button } from './Button';

export function OfflineQueueBanner() {
  const { count, flushing, flushNow } = useOfflineQueue();
  if (count === 0) return null;
  return (
    <aside className="banner banner--warn" role="status">
      <span className="material-symbols-outlined">cloud_off</span>
      <span>
        <strong className="num">{count} photo{count > 1 ? 's' : ''} en attente</strong>
        <br />
        <small>Envoi automatique dès que le réseau revient (app ouverte)</small>
      </span>
      <Button variant="outline" onClick={flushNow} disabled={flushing}>{flushing ? 'Envoi…' : 'Forcer l’envoi'}</Button>
    </aside>
  );
}
```

Modify `web/src/pages/EntreeCapturePage.tsx` `onFile` — queue instead of failing when offline or on a network error:
```tsx
import { enqueuePhoto, QueueFullError } from '../lib/offline-queue';
import { notifyQueueChanged } from '../lib/use-offline-queue';
// …
try {
  if (!navigator.onLine) throw new TypeError('offline');
  const { id } = await uploadPhoto(file);
  navigate(`/entree/${id}`);
} catch (err) {
  if (err instanceof TypeError) {
    try {
      await enqueuePhoto(file, 'single');
      notifyQueueChanged();
      setQueued(true);
    } catch (q) {
      setError(q instanceof QueueFullError ? q.message : 'File hors ligne indisponible');
    }
  } else {
    setError(err instanceof Error ? err.message : 'Envoi impossible');
  }
}
```
with `const [queued, setQueued] = useState(false);` and, in the JSX, `{queued && <p role="status">Photo mise en attente — elle partira dès que le réseau revient. La confirmation se fera depuis la revue groupée.</p>}`. (`fetch` rejects with a `TypeError` on network failure; an HTTP error becomes an `ApiError` and is shown, not queued.)

Modify `web/src/pages/HomePage.tsx` — render `<OfflineQueueBanner />` as the first child of `<main className="page">`. Modify `web/src/App.tsx` — nothing else needed: the hook is mounted by the banner on the home page, and the review page (Task 17) mounts it too; the counter is therefore visible on the two screens users land on after a cellar session.

- [ ] **Step 3: Run tests, simulate offline, commit**

Run: `cd web && npm test` → PASS.

Manual: DevTools → Network → Offline; *Rentrer du vin* → take photo → « Photo mise en attente »; Home shows « 1 photo en attente »; go back Online → banner disappears within a few seconds and the photo appears under `GET /api/photos/pending-review` once extracted.

```bash
git add web
git commit -m "feat(web): IndexedDB offline photo queue with foreground flush and visible counter"
```

---

### Task 17: Campaign mode — burst capture and grouped review

**Files:**
- Create: `web/src/pages/CampagneCapturePage.tsx`, `web/src/pages/CampagneReviewPage.tsx`, `web/src/pages/CampagneReviewPage.test.tsx`, `web/src/lib/api-client.ts` (extend: `getPendingReviewPhotos`, `createMovementsBulk`)
- Modify: `web/src/router.tsx`, `web/src/pages/HomePage.tsx` (link text → « Mode campagne »)

**Interfaces:**
- Consumes: `POST /api/photos`, `GET /api/photos/pending-review`, `POST /api/movements/bulk` (Tasks 9, 12), offline queue (Task 16).
- Produces: `getPendingReviewPhotos(): Promise<PhotoDto[]>`; `createMovementsBulk(items: CreateMovementInput[]): Promise<Array<{ ok: true; idempotencyKey: string; result: MovementResult } | { ok: false; idempotencyKey: string; error: string }>>`; routes `/entree/campagne` (capture) and `/entree/campagne/revue` (review). Review lists DONE-unconfirmed photos **sorted by global confidence ascending**, each row = thumbnail + editable draft + quantity picker + « Ignorer » toggle; one « Valider N fiches » button.

- [ ] **Step 1: api-client additions**

Append to `web/src/lib/api-client.ts`:
```ts
export const getPendingReviewPhotos = () => apiFetch<PhotoDto[]>('/photos/pending-review');
export type BulkResult = Array<{ ok: true; idempotencyKey: string; result: MovementResult } | { ok: false; idempotencyKey: string; error: string }>;
export const createMovementsBulk = (items: CreateMovementInput[]) =>
  apiFetch<BulkResult>('/movements/bulk', { method: 'POST', body: JSON.stringify(items) });
```

The review needs the parsed extraction, not the raw Gemini JSON. Extend `GET /api/photos/pending-review` (api, `photos.controller.ts`) to return `{ ...photo, extraction }`:
```ts
@Get('pending-review')
async pendingReview() {
  const photos = await this.photos.listPendingReview();
  return photos.map((p) => ({ ...p, extraction: p.rawExtraction ? parseExtraction(p.rawExtraction) : null }));
}
```
with `import { parseExtraction } from '../vision/extraction-schema';`, and add `extraction?: WineExtraction | null` to `PhotoDto` in the web client.

- [ ] **Step 2: Failing review-page test**

`web/src/pages/CampagneReviewPage.test.tsx`:
```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { CampagneReviewPage } from './CampagneReviewPage';

const ext = (producer: string, conf: number, qty: number | null): api.WineExtraction => ({
  producer: { value: producer, confidence: conf }, cuvee: { value: null, confidence: 0 }, appellation: { value: 'Bandol', confidence: conf },
  vintage: { value: 2019, confidence: conf }, color: { value: 'ROUGE', confidence: 1 }, formatCl: { value: 75, confidence: 1 },
  bottlesPerCase: { value: qty, confidence: 0.8 }, globalConfidence: conf,
});

it('lists low-confidence first and bulk-confirms the kept rows', async () => {
  vi.spyOn(api, 'getPendingReviewPhotos').mockResolvedValue([
    { id: 'p-high', status: 'DONE', createdAt: '', extraction: ext('Domaine Sûr', 0.95, 12) },
    { id: 'p-low', status: 'DONE', createdAt: '', extraction: ext('Domaine Douteux', 0.4, null) },
  ]);
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockResolvedValue([
    { ok: true, idempotencyKey: 'x', result: { movement: { id: 'm', delta: 12, type: 'IN', occurredAt: '' }, wine: { id: 'w', producer: 'Domaine Sûr', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 12, created: true } },
  ]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><CampagneReviewPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  const rows = await screen.findAllByRole('article');
  expect(within(rows[0]).getByDisplayValue('Domaine Douteux')).toBeInTheDocument();
  await userEvent.click(within(rows[0]).getByRole('button', { name: /Ignorer/ }));
  await userEvent.click(screen.getByRole('button', { name: /Valider 1 fiche/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const items = bulk.mock.calls[0][0];
  expect(items).toHaveLength(1);
  expect(items[0].photoId).toBe('p-high');
  expect(items[0].quantity).toBe(12);
  expect(await screen.findByText(/1 fiche validée/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to see it fail, implement pages**

Run: `cd web && npx vitest run src/pages/Campagne` → FAIL.

`web/src/pages/CampagneCapturePage.tsx`:
```tsx
import { ChangeEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { TopBar } from '../components/TopBar';
import { uploadPhoto } from '../lib/api-client';
import { enqueuePhoto, QueueFullError } from '../lib/offline-queue';
import { notifyQueueChanged } from '../lib/use-offline-queue';

export function CampagneCapturePage() {
  const input = useRef<HTMLInputElement>(null);
  const [taken, setTaken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      await uploadPhoto(file);
    } catch (err) {
      if (!(err instanceof TypeError)) return setError(err instanceof Error ? err.message : 'Envoi impossible');
      try {
        await enqueuePhoto(file, 'campaign');
        notifyQueueChanged();
      } catch (q) {
        return setError(q instanceof QueueFullError ? q.message : 'File hors ligne indisponible');
      }
    }
    setTaken((n) => n + 1);
    input.current?.click(); // enchaîner : photo, suivante — aucune confirmation unitaire
  }

  return (
    <>
      <TopBar title="Mode campagne" back="/" />
      <main className="page capture">
        <OfflineQueueBanner />
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>
          Photographiez chaque référence à la suite. L’analyse se fait en arrière-plan ; vous validerez tout d’un coup dans la revue.
        </p>
        <p className="num" style={{ fontSize: 40, margin: 0 }}>{taken}</p>
        <small>photos prises dans cette session</small>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Photo suivante" />
        <Button variant="primary" onClick={() => input.current?.click()} style={{ width: '100%', minHeight: 'var(--size-action-height)' }}>
          <span className="material-symbols-outlined">photo_camera</span>
          {taken === 0 ? 'Commencer' : 'Photo suivante'}
        </Button>
        {error && <p role="alert" className="text-error">{error}</p>}
        <Link to="/entree/campagne/revue" className="btn btn--outline">Passer à la revue groupée</Link>
      </main>
    </>
  );
}
```

`web/src/pages/CampagneReviewPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { EditableField } from '../components/EditableField';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { QuantityPicker } from '../components/QuantityPicker';
import { TopBar } from '../components/TopBar';
import { BulkResult, createMovementsBulk, getPendingReviewPhotos, PhotoDto, WineDraft } from '../lib/api-client';
import { extractionToDraft } from '../lib/extraction-to-draft';

interface Row {
  photoId: string;
  idempotencyKey: string;
  draft: WineDraft;
  confidences: Partial<Record<keyof WineDraft, number>>;
  globalConfidence: number;
  quantity: number;
  detected: number | null;
  ignored: boolean;
}

function toRow(p: PhotoDto): Row | null {
  if (!p.extraction) return null;
  const { draft, confidences, detectedQuantity } = extractionToDraft(p.extraction);
  return { photoId: p.id, idempotencyKey: crypto.randomUUID(), draft, confidences, globalConfidence: p.extraction.globalConfidence, quantity: detectedQuantity ?? 1, detected: detectedQuantity, ignored: false };
}

export function CampagneReviewPage() {
  const photos = useQuery({ queryKey: ['pending-review'], queryFn: getPendingReviewPhotos, refetchInterval: 15_000 });
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!photos.data) return;
    setRows((prev) => {
      const known = new Map(prev.map((r) => [r.photoId, r]));
      return photos.data
        .map((p) => known.get(p.id) ?? toRow(p))
        .filter((r): r is Row => r !== null)
        .sort((a, b) => a.globalConfidence - b.globalConfidence);
    });
  }, [photos.data]);

  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.photoId === id ? { ...r, ...patch } : r)));
  const kept = rows.filter((r) => !r.ignored && r.draft.producer && r.draft.appellationRaw);

  async function validate() {
    setBusy(true);
    try {
      const res = await createMovementsBulk(
        kept.map((r) => ({ idempotencyKey: r.idempotencyKey, photoId: r.photoId, wine: { ...r.draft, cuvee: r.draft.cuvee || null, vintage: r.draft.vintage ?? null }, quantity: r.quantity })),
      );
      setResult(res);
      const okKeys = new Set(res.filter((x) => x.ok).map((x) => x.idempotencyKey));
      setRows((rs) => rs.filter((r) => !okKeys.has(r.idempotencyKey)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Revue groupée" back="/entree/campagne" />
      <main className="page" style={{ paddingBottom: 140 }}>
        <OfflineQueueBanner />
        {result && (
          <p role="status" className="badge badge--ok">
            {result.filter((x) => x.ok).length} fiche{result.filter((x) => x.ok).length > 1 ? 's' : ''} validée{result.filter((x) => x.ok).length > 1 ? 's' : ''}
            {result.some((x) => !x.ok) && ` · ${result.filter((x) => !x.ok).length} en erreur`}
          </p>
        )}
        {photos.isPending && <p className="centered">Chargement…</p>}
        {rows.length === 0 && !photos.isPending && <p className="centered">Aucune fiche à revoir. Les photos en cours d’analyse apparaîtront ici.</p>}
        {rows.map((r) => (
          <article key={r.photoId} className="card" style={{ opacity: r.ignored ? 0.5 : 1 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <img src={`/api/photos/${r.photoId}/image`} alt="" width={64} height={80} style={{ objectFit: 'cover', borderRadius: 8 }} />
              <span className={`badge ${r.globalConfidence >= 0.7 ? 'badge--ok' : 'badge--warn'}`}>confiance {Math.round(r.globalConfidence * 100)} %</span>
              <Button variant="link" onClick={() => update(r.photoId, { ignored: !r.ignored })}>{r.ignored ? 'Reprendre' : 'Ignorer'}</Button>
            </div>
            {!r.ignored && (
              <>
                <EditableField label="Producteur" serif value={r.draft.producer} confidence={r.confidences.producer} onChange={(v) => update(r.photoId, { draft: { ...r.draft, producer: v } })} />
                <EditableField label="Cuvée" serif value={r.draft.cuvee ?? ''} confidence={r.confidences.cuvee} onChange={(v) => update(r.photoId, { draft: { ...r.draft, cuvee: v } })} />
                <EditableField label="Appellation" serif value={r.draft.appellationRaw} confidence={r.confidences.appellationRaw} onChange={(v) => update(r.photoId, { draft: { ...r.draft, appellationRaw: v } })} />
                <EditableField label="Millésime" type="number" value={r.draft.vintage?.toString() ?? ''} confidence={r.confidences.vintage} onChange={(v) => update(r.photoId, { draft: { ...r.draft, vintage: v ? Number(v) : null } })} />
                <QuantityPicker value={r.quantity} detected={r.detected} onChange={(n) => update(r.photoId, { quantity: n })} />
              </>
            )}
          </article>
        ))}
        {rows.length > 0 && (
          <div className="dock">
            <Button variant="dark" onClick={validate} disabled={busy || kept.length === 0}>
              Valider {kept.length} fiche{kept.length > 1 ? 's' : ''}
            </Button>
            <span className="dock__hint">Un mouvement IN par fiche · les fiches ignorées restent à revoir</span>
          </div>
        )}
      </main>
    </>
  );
}
```

Modify `web/src/router.tsx` — add `{ path: '/entree/campagne', element: <CampagneCapturePage /> }` and `{ path: '/entree/campagne/revue', element: <CampagneReviewPage /> }` **before** `/entree/:photoId` so the literal segment wins (React Router ranks static segments higher anyway, but keep the order readable). Modify `HomePage` link label to « Mode campagne (reprise de la cave) ».

- [ ] **Step 4: Run tests, manual burst, commit**

Run: `cd web && npm test` → PASS.

Manual: Home → *Mode campagne* → take 5 photos in a row (camera reopens after each) → *Passer à la revue groupée* → rows appear as extractions complete (15 s refetch), lowest confidence first → ignore one, fix a vintage, *Valider 4 fiches* → « 4 fiches validées » and the export shows them.

```bash
git add web api/src/photos/photos.controller.ts
git commit -m "feat(web): campaign mode with burst capture and grouped review"
```

---

### Task 18: Journal — recent movements with one-tap cancel, and the Export button

**Files:**
- Create: `web/src/pages/JournalPage.tsx`, `web/src/pages/JournalPage.test.tsx`, `web/src/lib/api-client.ts` (extend: `getRecentMovements`, `cancelMovement`, `exportUrl`)
- Modify: `web/src/router.tsx`, `web/src/pages/HomePage.tsx` (link « Exporter le classeur » + 3 derniers mouvements)

**Interfaces:**
- Consumes: `GET /api/movements/recent`, `POST /api/movements/:id/cancel`, `GET /api/export.xlsx` (Tasks 12, 13).
- Produces: `interface MovementWithWine { id; delta; type; occurredAt; note; reversesId: string | null; wine: { id; producer; cuvee; appellationRaw; vintage } }`; `getRecentMovements(limit?)`, `cancelMovement(id, idempotencyKey)`, `exportUrl(filter?: { color?: WineColor; region?: string }): string`; route `/journal`.

- [ ] **Step 1: api-client additions**

```ts
export interface MovementWithWine {
  id: string; delta: number; type: 'IN' | 'OUT' | 'ADJUST'; occurredAt: string; note: string | null; reversesId: string | null;
  wine: { id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null };
}
export const getRecentMovements = (limit = 20) => apiFetch<MovementWithWine[]>(`/movements/recent?limit=${limit}`);
export const cancelMovement = (id: string, idempotencyKey: string) =>
  apiFetch<MovementResult>(`/movements/${id}/cancel`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) });
export function exportUrl(filter: { color?: WineColor; region?: string } = {}) {
  const q = new URLSearchParams();
  if (filter.color) q.set('color', filter.color);
  if (filter.region) q.set('region', filter.region);
  const s = q.toString();
  return `/api/export.xlsx${s ? `?${s}` : ''}`;
}
```

- [ ] **Step 2: Failing Journal test**

`web/src/pages/JournalPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import { JournalPage } from './JournalPage';

const wine = { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019 };

it('lists movements, cancels with an inverse movement and never shows Annuler on a reversal', async () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([
    { id: 'm2', delta: -6, type: 'ADJUST', occurredAt: '2026-09-20T10:00:00Z', note: 'Annulation du mouvement m0', reversesId: 'm0', wine },
    { id: 'm1', delta: 12, type: 'IN', occurredAt: '2026-09-19T10:00:00Z', note: null, reversesId: null, wine },
  ]);
  const cancel = vi.spyOn(api, 'cancelMovement').mockResolvedValue({ movement: { id: 'm3', delta: -12, type: 'ADJUST', occurredAt: '' }, wine: { ...wine, color: 'ROUGE', formatCl: 75 }, stock: 0, created: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><JournalPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('+12')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Annuler/ })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: /Annuler/ }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('m1', expect.stringMatching(/^[0-9a-f-]{36}$/)));
  expect(screen.getByRole('link', { name: /Exporter le classeur/ })).toHaveAttribute('href', '/api/export.xlsx');
});
```

- [ ] **Step 3: Run to see it fail, implement JournalPage, routes, home links**

Run: `cd web && npx vitest run src/pages/Journal` → FAIL.

`web/src/pages/JournalPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { TopBar } from '../components/TopBar';
import { cancelMovement, exportUrl, getRecentMovements, MovementWithWine, WineColor } from '../lib/api-client';

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function MovementRow({ m, onCancel, cancelling }: { m: MovementWithWine; onCancel?: (id: string) => void; cancelling?: boolean }) {
  const isIn = m.delta > 0;
  return (
    <div className="list__row">
      <span className="material-symbols-outlined" style={{ color: isIn ? 'var(--color-primary-action)' : 'var(--color-secondary)' }}>{isIn ? 'add' : 'remove'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span className={`list__delta ${isIn ? 'list__delta--in' : 'list__delta--out'} num`}>{isIn ? `+${m.delta}` : m.delta}</span>
        <span className="list__meta"> · {fmt.format(new Date(m.occurredAt))}</span>
        <p className="list__title" style={{ margin: 0 }}>
          {m.wine.producer}{m.wine.cuvee ? ` — ${m.wine.cuvee}` : ''} {m.wine.vintage ?? ''}
        </p>
        <span className="list__meta">{m.wine.appellationRaw}{m.note ? ` · ${m.note}` : ''}</span>
      </div>
      {onCancel && !m.reversesId && (
        <Button variant="outline" onClick={() => onCancel(m.id)} disabled={cancelling}>Annuler</Button>
      )}
    </div>
  );
}

export function JournalPage() {
  const qc = useQueryClient();
  const movements = useQuery({ queryKey: ['movements', 'recent'], queryFn: () => getRecentMovements(20) });
  const [color, setColor] = useState<WineColor | ''>('');
  const cancel = useMutation({
    mutationFn: (id: string) => cancelMovement(id, crypto.randomUUID()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['movements'] }),
  });

  return (
    <>
      <TopBar title="Journal" />
      <main className="page">
        <section className="card">
          <h2 style={{ fontSize: 18 }}>Export Excel</h2>
          <label className="field__label" style={{ marginTop: 8 }}>
            Filtre couleur
            <select value={color} onChange={(e) => setColor(e.target.value as WineColor | '')}>
              <option value="">Toute la cave</option>
              <option value="ROUGE">Rouge</option>
              <option value="BLANC">Blanc</option>
              <option value="ROSE">Rosé</option>
              <option value="PETILLANT">Pétillant</option>
            </select>
          </label>
          <a className="btn btn--primary" style={{ width: '100%', marginTop: 8 }} href={exportUrl(color ? { color } : {})} download>
            <span className="material-symbols-outlined">download</span>
            Exporter le classeur
          </a>
        </section>
        <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>20 DERNIERS MOUVEMENTS</h2>
        {cancel.isError && <p role="alert" className="text-error">{(cancel.error as Error).message}</p>}
        <div className="list">
          {movements.data?.map((m) => <MovementRow key={m.id} m={m} onCancel={(id) => cancel.mutate(id)} cancelling={cancel.isPending} />)}
          {movements.data?.length === 0 && <p className="centered">Aucun mouvement pour l’instant.</p>}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
```

Modify `web/src/router.tsx` — add `{ path: '/journal', element: <JournalPage /> }`. Modify `web/src/pages/HomePage.tsx` — after the campaign link, add a « Derniers mouvements » block using `useQuery(['movements','recent'], () => getRecentMovements(3))` and `<MovementRow m={m} />` (no cancel on home), plus `<Link to="/journal" className="btn btn--link">Voir le journal</Link>`; update `HomePage.test.tsx` to mock `getRecentMovements` (`vi.spyOn(api, 'getRecentMovements').mockResolvedValue([])`) and wrap in a `QueryClientProvider`.

- [ ] **Step 4: Run tests, verify the Lot 1 completion criterion, commit**

Run: `cd web && npm test && cd ../api && npm test` → PASS.

Manual — the cahier des charges' exit criterion for Lot 1 (« un carton de 12 est rentré en moins de 60 s et figure dans le classeur exporté »): stopwatch from tapping *Rentrer du vin* on a 12-bottle carton photo to « Stock : 12 » → under 60 s; Journal → *Exporter le classeur* → the wine appears in `Stock` with quantity 12; *Annuler* on that movement → a −12 ADJUST row appears, a second *Annuler* is not offered, and the export no longer lists the wine.

```bash
git add web
git commit -m "feat(web): journal with one-tap cancel and Excel export button"
```

---

## Self-review notes (already applied)

- **Spec coverage.** Socle (Compose/Postgres/Google auth/PWA/CI) → Tasks 1–6. Entrée flow (photo → normalisation → Gemini JSON strict + confiance par champ → recalage `pg_trgm` 0,5/0,8 → clé de matching → confirmation éditable → 1/6/12/18 → mouvement IN) → Tasks 7–12, 14–15. Mode campagne (rafale, 4–6 en parallèle, back-off, revue triée par confiance) → Tasks 11 (concurrency 5, exponential back-off) and 17. Hors ligne (IndexedDB, 20 photos/50 Mo, premier plan seulement, compteur visible) → Task 16. Historique + annulation par mouvement inverse → Tasks 12, 18. Export Excel 3 feuilles, régénéré, filtre → Tasks 13, 18. Idempotence (hash photo, clé mouvement) → Tasks 9, 12. Stock jamais négatif → Task 2. `raw_extraction` verbatim → Task 11. Tokens en un fichier, aucune valeur en dur → Task 14. Plafond mensuel vision → Task 11. Secrets hors image/dépôt → Task 3. Conventions `magazine-search` (GHCR, port unique, sauvegardes) → Tasks 3, 5.
- **Deliberate simplifications, all inside the spec's latitude:** image « redressement » is EXIF auto-rotation only (no perspective deskew) — Gemini reads tilted labels fine and the original is kept for replay; `fuzzy` appellation matches are auto-applied but flagged through the field's confidence rather than a separate « proposer » dialog; a `campaign` is not a database entity (a photo is « à revoir » while it has no movement), which keeps the schema identical to the spec.
- **Type consistency checked:** `WineDraft`, `CreateMovementInput`, `MovementResult`, `WineExtraction`/`ExtractedField`, `PhotoDto`, `AppellationMatch`, `VISION_PROVIDER`, `EXTRACTION_QUEUE_TOKEN`, `PHOTO_STORAGE_DIR` are spelled identically in every task that uses them; `PhotosService`'s constructor gains its 4th (queue) parameter in Task 11 and the Task 9 tests are updated there.
- **Out of scope, on purpose (Lot 2+):** `OUT` movements, list-based sortie, apogée, cote iDealwine, dark « mode cave », emplacements, alertes.
