# Lot 2a — la cave et la sortie : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boucler le cycle du stock : liste de la cave, fiche vin, sortie par la liste, sortie par photo (reconnaissance restreinte aux vins en stock, choix final sur vignettes) et inventaire physique.

**Architecture:** Côté API, un nouveau module `cave` (liste, fiche, inventaire, candidats de sortie) s'appuie sur une fonction pure de classement (`rankExitCandidates`) et sur `MovementsService`, qui gagne `createOut` et `adjustTo`. Les photos portent désormais une destination (`ENTRY` / `EXIT`) qui les tient à l'écart de la revue groupée et leur donne une politique de file courte. Côté web, quatre écrans (`/cave`, `/cave/:wineId`, `/sortie`, `/sortie/:photoId`) partagent un panneau de confirmation de sortie.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL 16 (`pg_trgm`), BullMQ, Jest ; React 18, Vite 5, TanStack Query 5, React Router 6, Vitest + Testing Library.

**Spec:** [`docs/superpowers/specs/2026-10-04-cave-a-vin-lot2a-cave-et-sortie-design.md`](../specs/2026-10-04-cave-a-vin-lot2a-cave-et-sortie-design.md)

## Global Constraints

- Tous les textes d'interface, messages d'erreur, commentaires et messages de commit sont **en français**.
- Aucune sortie n'est écrite sans confirmation explicite de l'utilisateur (« sans faux débit »).
- Toute écriture de mouvement porte une clé d'idempotence UUID (`crypto.randomUUID()` côté web).
- Le stock ne peut jamais devenir négatif ; l'arbitre final est le déclencheur `check_stock_non_negative` en base.
- Le doré (`btn--primary`, `action--in`) est réservé à l'entrée ; la ferronnerie noire (`btn--dark`, `action--out`) à la sortie et à la validation.
- Aucune nouvelle variable d'environnement ; `docker-compose.yml` inchangé (le job CI `compose` doit rester vert).
- Les index uniques partiels et les fonctions SQL sont écrits à la main dans les migrations (Prisma ne sait pas les exprimer) ; ne jamais laisser `prisma migrate dev` les supprimer.
- Constantes de reconnaissance, valeurs exactes : `W_NAME` 0.6, `W_APPELLATION` 0.4, `VINTAGE_MATCH_BONUS` 0.25, `VINTAGE_MISMATCH_FACTOR` 0.3, `MIN_CANDIDATE_SCORE` 0.35, `UNIQUE_MIN_SCORE` 0.6, `UNIQUE_MIN_GAP` 0.15, `MAX_CANDIDATES` 4.
- Photo de sortie : `EXIT_ATTEMPTS` = 2, délai fixe `EXIT_RETRY_DELAY_MS` = 3000, aucun report ; côté web `EXIT_FALLBACK_MS` = 12000.
- Commandes : API `cd api && npx jest <fichier>` ; web `cd web && npx vitest run <fichier>` ; lint `npm run lint` dans chaque paquet ; les specs d'intégration (`*.integration.spec.ts`) ne tournent qu'avec `DATABASE_URL` (CI).
- Commits `feat:` / `fix:` pour le code (ils déclenchent la version 1.2.0), `docs:` / `test:` / `chore:` pour le reste ; terminer chaque message par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Deux sorties simultanées de la dernière bouteille** (deux téléphones) → une seule passe, l'autre reçoit « Il n'en reste que 0 ». Le déclencheur actuel lit la somme sans verrou : corrigé et testé de façon déterministe en tâche 1.
2. **Photo de sortie aux octets identiques à une photo d'entrée** (déduplication par empreinte) → la reconnaissance fonctionne quand même sur la photo existante. Test en tâche 5.
3. **Quantité demandée supérieure au stock** dans la fiche → le sélecteur est borné, et un `409` de l'API s'affiche en clair sans rien écrire. Test en tâche 7.
4. **Vin sans photo de référence** (saisi à la main) → pictogramme de bouteille, jamais d'image cassée. Test en tâche 6.
5. **Recherche avec accents et casse différents** (« chateauneuf » trouve « Châteauneuf-du-Pape ») → test de `filterCave` en tâche 5.

---

## Structure des fichiers

| Fichier | Rôle |
| --- | --- |
| `api/prisma/schema.prisma` | `PhotoPurpose`, `photo.purpose` |
| `api/prisma/migrations/20261004000000_lot2a_sortie/migration.sql` | enum + colonne, verrou du déclencheur, index `idx_movement_photo_out`, rattrapage `reference_photo_id` |
| `api/src/prisma/exit.integration.spec.ts` | tests d'intégration du lot (concurrence, index, rattrapage) |
| `api/src/queue/extraction.queue.ts` | `EXIT_ATTEMPTS`, `EXIT_RETRY_DELAY_MS`, `jobOptionsFor` |
| `api/src/queue/extraction.processor.ts` | message d'abandon selon la destination |
| `api/src/queue/orphan-recovery.ts` | photos de sortie abandonnées au démarrage |
| `api/src/photos/photos.service.ts` / `photos.controller.ts` | `purpose` à l'envoi, filtres revue + compteur |
| `api/src/wines/trigram.ts` | similarité trigramme (définition `pg_trgm`) |
| `api/src/wines/exit-ranking.ts` | `rankExitCandidates` et constantes |
| `api/src/movements/dto.ts` / `movements.service.ts` / `movements.controller.ts` | `createOut`, `adjustTo`, photo de référence à l'entrée |
| `api/src/cave/cave.service.ts` / `cave.controller.ts` / `cave.module.ts` / `cave-filter.ts` | liste, fiche, inventaire, candidats de sortie |
| `web/src/lib/api-client.ts` | appels et types du lot |
| `web/src/components/WineThumb.tsx` | vignette ou pictogramme |
| `web/src/components/SortieConfirmation.tsx` | panneau de confirmation de sortie partagé |
| `web/src/pages/CavePage.tsx` / `WinePage.tsx` / `SortieCapturePage.tsx` / `SortieResolutionPage.tsx` | écrans |
| `web/src/router.tsx`, `BottomNav.tsx`, `HomePage.tsx`, `styles/base.css` | câblage |
| `README.md`, `CHANGELOG.md` | documentation |

---

### Task 1: Base de données — destination des photos, verrou du stock, une sortie par photo, photos de référence

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20261004000000_lot2a_sortie/migration.sql`
- Create: `api/src/prisma/exit.integration.spec.ts`

**Interfaces:**
- Produces: enum Prisma `PhotoPurpose` (`ENTRY` | `EXIT`), champ `Photo.purpose` (défaut `ENTRY`) ; index `idx_movement_photo_out` ; déclencheur `check_stock_non_negative` qui verrouille la ligne `wine`.

- [ ] **Step 1: Écrire les tests d'intégration (échouent tant que la migration n'existe pas)**

`api/src/prisma/exit.integration.spec.ts` :

```ts
import { PrismaClient, WineColor } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

describeIfDb('lot 2a — sortie (base réelle)', () => {
  const prisma = new PrismaClient();
  const wineIds: string[] = [];
  const photoIds: string[] = [];

  async function wineWithStock(quantity: number) {
    const wine = await prisma.wine.create({
      data: { matchKey: key('lot2a'), producer: 'Domaine Test', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineIds.push(wine.id);
    if (quantity > 0) await prisma.movement.create({ data: { wineId: wine.id, delta: quantity, type: 'IN', idempotencyKey: key('in') } });
    return wine;
  }

  async function photo(purpose: 'ENTRY' | 'EXIT' = 'ENTRY') {
    const p = await prisma.photo.create({ data: { contentHash: key('hash'), storagePath: 'normalized/x.jpg', purpose } });
    photoIds.push(p.id);
    return p;
  }

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId: { in: wineIds } } });
    await prisma.wine.deleteMany({ where: { id: { in: wineIds } } });
    await prisma.photo.deleteMany({ where: { id: { in: photoIds } } });
    await prisma.$disconnect();
  });

  it('ne laisse passer qu’une des deux sorties simultanées de la dernière bouteille', async () => {
    const wine = await wineWithStock(1);
    // La première sortie reste non validée pendant 400 ms : sans verrou, la seconde
    // lirait encore « 1 en stock » et passerait aussi, laissant le stock à -1.
    const first = prisma.$transaction(async (tx) => {
      await tx.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', idempotencyKey: key('out-a') } });
      await sleep(400);
    });
    await sleep(100);
    const second = prisma.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', idempotencyKey: key('out-b') } });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const sum = await prisma.movement.aggregate({ _sum: { delta: true }, where: { wineId: wine.id } });
    expect(sum._sum.delta).toBe(0);
  });

  it('refuse une seconde sortie avec la même photo, même avec une autre clé d’idempotence', async () => {
    const wine = await wineWithStock(3);
    const p = await photo('EXIT');
    await prisma.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', photoId: p.id, idempotencyKey: key('o1') } });
    await expect(
      prisma.movement.create({ data: { wineId: wine.id, delta: -1, type: 'OUT', photoId: p.id, idempotencyKey: key('o2') } }),
    ).rejects.toThrow();
  });

  it('le rattrapage retient la photo de la plus ancienne entrée comme photo de référence', async () => {
    const wine = await wineWithStock(0);
    const older = await photo();
    const newer = await photo();
    await prisma.movement.create({ data: { wineId: wine.id, delta: 2, type: 'IN', photoId: newer.id, idempotencyKey: key('n'), occurredAt: new Date('2026-09-02') } });
    await prisma.movement.create({ data: { wineId: wine.id, delta: 1, type: 'IN', photoId: older.id, idempotencyKey: key('o'), occurredAt: new Date('2026-09-01') } });
    // La migration a déjà tourné avant les tests : on rejoue sa requête de
    // rattrapage, lue dans le fichier même, pour tester le SQL livré.
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261004000000_lot2a_sortie/migration.sql'), 'utf8');
    const start = sql.indexOf('UPDATE wine w');
    await prisma.$executeRawUnsafe(sql.slice(start, sql.indexOf(';', start)));
    expect((await prisma.wine.findUnique({ where: { id: wine.id } }))?.referencePhotoId).toBe(older.id);
  });

  it('donne ENTRY par défaut à une photo', async () => {
    const p = await prisma.photo.create({ data: { contentHash: key('hash'), storagePath: 'normalized/y.jpg' } });
    photoIds.push(p.id);
    expect(p.purpose).toBe('ENTRY');
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

Run: `cd api && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave npx jest src/prisma/exit.integration.spec.ts`
Expected: FAIL — erreur TypeScript « Object literal may only specify known properties, and 'purpose' does not exist » (le champ n'existe pas encore). Sans base locale, la suite est ignorée : l'échec réel se verra en CI ; c'est acceptable pour cette tâche, le verrou est vérifié par la CI au push.

- [ ] **Step 3: Mettre à jour le schéma Prisma**

Dans `api/prisma/schema.prisma`, ajouter l'énumération après `enum PhotoStatus { … }` :

```prisma
enum PhotoPurpose {
  ENTRY
  EXIT
}
```

et dans `model Photo`, après la ligne `status        PhotoStatus @default(PENDING)` :

```prisma
  purpose       PhotoPurpose @default(ENTRY)
```

- [ ] **Step 4: Écrire la migration à la main**

`api/prisma/migrations/20261004000000_lot2a_sortie/migration.sql` :

```sql
-- Lot 2a — la cave et la sortie.

-- 1. Destination des photos. Une photo de sortie ne doit ni apparaître dans la
-- revue groupée (elle serait prise pour un vin à rentrer), ni compter dans le
-- bandeau d'attente, ni être reprise au démarrage du worker.
CREATE TYPE "PhotoPurpose" AS ENUM ('ENTRY', 'EXIT');
ALTER TABLE "photo" ADD COLUMN "purpose" "PhotoPurpose" NOT NULL DEFAULT 'ENTRY';

-- 2. Stock jamais négatif, y compris sous concurrence. La version précédente
-- lisait SUM(delta) sans verrou : deux sorties simultanées de la dernière
-- bouteille lisaient toutes deux « 1 » et passaient toutes deux. Le verrou sur
-- la ligne `wine` sérialise les mouvements d'un même vin ; en READ COMMITTED,
-- la lecture qui suit le verrou voit le mouvement validé entre-temps.
CREATE OR REPLACE FUNCTION check_stock_non_negative() RETURNS TRIGGER AS $$
DECLARE current_stock INTEGER;
BEGIN
  IF NEW.delta = 0 THEN
    RAISE EXCEPTION 'movement.delta ne peut pas être nul';
  END IF;
  PERFORM 1 FROM wine WHERE id = NEW.wine_id FOR UPDATE;
  SELECT COALESCE(SUM(delta), 0) INTO current_stock FROM movement WHERE wine_id = NEW.wine_id;
  IF current_stock + NEW.delta < 0 THEN
    RAISE EXCEPTION 'il ne reste aucune bouteille de ce vin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Une photo ne sert qu'à une seule sortie, même avec deux clés
-- d'idempotence différentes (double tap, deux onglets) : garde-fou contre le
-- faux débit.
CREATE UNIQUE INDEX idx_movement_photo_out ON movement (photo_id) WHERE photo_id IS NOT NULL AND type = 'OUT';

-- 4. Photo de référence de chaque vin : celle de sa première entrée. La
-- colonne existait mais n'était jamais renseignée.
UPDATE wine w
SET reference_photo_id = (
  SELECT m.photo_id FROM movement m
  WHERE m.wine_id = w.id AND m.type = 'IN' AND m.photo_id IS NOT NULL
  ORDER BY m.occurred_at ASC
  LIMIT 1
)
WHERE w.reference_photo_id IS NULL;
```

- [ ] **Step 5: Régénérer le client et vérifier la cohérence schéma ↔ migrations**

Run: `cd api && npx prisma generate && npx prisma validate && npx tsc --noEmit -p tsconfig.build.json`
Expected: « The schema at prisma/schema.prisma is valid » et aucune erreur TypeScript.

Si une base locale est disponible (`LC_ALL=C` pour démarrer PostgreSQL sous macOS) :
Run: `cd api && DATABASE_URL=… npx prisma migrate deploy && DATABASE_URL=… npx jest src/prisma/`
Expected: PASS, y compris `stock.integration.spec.ts` existant.

- [ ] **Step 6: Commit**

```bash
git add api/prisma/schema.prisma api/prisma/migrations/20261004000000_lot2a_sortie api/src/prisma/exit.integration.spec.ts
git commit -m "fix(stock): verrouiller le vin avant de vérifier le stock, une sortie par photo

Le déclencheur « stock jamais négatif » lisait la somme des mouvements sans
verrou : deux sorties simultanées de la dernière bouteille passaient toutes
les deux. Il verrouille désormais la ligne du vin. La migration ajoute aussi
la destination des photos (entrée ou sortie), l'index d'une sortie par photo
et le rattrapage des photos de référence.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Photos de sortie — envoi, file courte, exclusion de la revue, du compteur et de la reprise

**Files:**
- Modify: `api/src/queue/extraction.queue.ts`
- Modify: `api/src/queue/extraction.processor.ts`, `api/src/queue/extraction.processor.spec.ts`
- Modify: `api/src/queue/orphan-recovery.ts`, `api/src/queue/orphan-recovery.spec.ts`
- Modify: `api/src/photos/photos.service.ts`, `api/src/photos/photos.service.spec.ts`
- Modify: `api/src/photos/photos.controller.ts`

**Interfaces:**
- Consumes: `PhotoPurpose` (tâche 1).
- Produces: `EXIT_ATTEMPTS = 2`, `EXIT_RETRY_DELAY_MS = 3000`, `jobOptionsFor(purpose: PhotoPurpose): JobsOptions` dans `extraction.queue.ts` ; `PhotosService.ingest(input: Buffer, mimeType: string, purpose: PhotoPurpose = 'ENTRY')` ; `POST /photos` accepte le champ de formulaire `purpose`.

- [ ] **Step 1: Écrire les tests qui échouent**

Dans `api/src/photos/photos.service.spec.ts`, ajouter à la fin du `describe('PhotosService.ingest', …)` (avant sa fermeture) :

```ts
  it('met une photo de sortie en file avec la politique courte (deux tentatives, sans report)', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#456' } }).jpeg().toBuffer();
    const { photo } = await service.ingest(img, 'image/jpeg', 'EXIT');
    expect(photo.purpose).toBe('EXIT');
    expect(queue.add).toHaveBeenCalledWith(
      'extract',
      { photoId: photo.id },
      { jobId: photo.id, attempts: 2, backoff: { type: 'fixed', delay: 3000 } },
    );
  });
```

et à la fin du fichier :

```ts
describe('PhotosService — photos de sortie tenues à l’écart', () => {
  it('ne liste dans la revue groupée que les photos d’entrée', async () => {
    const findMany = jest.fn(async () => []);
    const service = new PhotosService({ photo: { findMany } } as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await service.listPendingReview();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'DONE', purpose: 'ENTRY', movements: { none: {} } } }));
  });

  it('ne compte dans l’attente que les photos d’entrée', async () => {
    const count = jest.fn(async () => 0);
    const findFirst = jest.fn(async () => null);
    const service = new PhotosService({ photo: { count, findFirst } } as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await service.queueStatus();
    expect(count).toHaveBeenCalledWith({ where: { status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'ENTRY' } });
  });
});
```

Dans le `fakePrisma()` de ce fichier, la ligne `create` doit conserver `purpose` ; elle le fait déjà via `...data`, mais donner une valeur par défaut :

```ts
        const p = { id: data.id ?? `p${photos.length + 1}`, status: 'PENDING', purpose: 'ENTRY', createdAt: new Date(), ...data };
```

Dans `api/src/queue/orphan-recovery.spec.ts`, modifier le harnais pour accepter une destination et suivre les mises à jour — remplacer la ligne `const prisma = { photo: { findMany: jest.fn(async () => photos) } };` par :

```ts
  const updated: { id: string; data: any }[] = [];
  const prisma = {
    photo: {
      findMany: jest.fn(async () => photos),
      update: jest.fn(async ({ where, data }: any) => {
        updated.push({ id: where.id, data });
        return {};
      }),
    },
  };
```

et `return { prisma, queue, added, removed };` par `return { prisma, queue, added, removed, updated };`. Changer la signature en `function harness(photos: { id: string; purpose?: 'ENTRY' | 'EXIT' }[], …)`. Puis ajouter :

```ts
  it('abandonne une photo de sortie restée en attente au lieu de la remettre en file', async () => {
    const h = harness([{ id: 'p1', purpose: 'EXIT' }, { id: 'p2', purpose: 'ENTRY' }]);
    expect(await requeueOrphanPhotos(h.prisma, h.queue as never)).toBe(1);
    expect(h.added).toEqual(['p2']);
    expect(h.updated).toEqual([{ id: 'p1', data: { status: 'FAILED', errorMessage: 'Photo de sortie abandonnée au redémarrage' } }]);
  });
```

et remplacer l'assertion du test « ne cherche que les photos en attente ou en cours » par :

```ts
    expect(h.prisma.photo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['PENDING', 'PROCESSING'] } }, select: { id: true, purpose: true } }),
    );
```

Dans `api/src/queue/extraction.processor.spec.ts`, ajouter dans le `describe('panne passagère …')` :

```ts
    it('annonce l’abandon d’une photo de sortie après ses deux tentatives', async () => {
      const h = harness({ visionError: GEMINI_503 });
      h.photo.purpose = 'EXIT';
      await expect(h.processor.process('p1', true)).rejects.toBe(GEMINI_503);
      expect(h.photo.status).toBe('FAILED');
      expect(h.photo.errorMessage).toContain('abandon après 2 tentatives');
    });
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `cd api && npx jest src/photos/photos.service.spec.ts src/queue/orphan-recovery.spec.ts src/queue/extraction.processor.spec.ts`
Expected: FAIL — `ingest` ignore le troisième argument, les `where` n'ont pas `purpose`, la reprise remet `p1` en file, le message dit « 1000 tentatives ».

- [ ] **Step 3: Politique de file par destination**

Dans `api/src/queue/extraction.queue.ts`, ajouter l'import `import { JobsOptions, Queue } from 'bullmq';` (remplace `import { Queue } from 'bullmq';`), `import { PhotoPurpose } from '@prisma/client';`, et après `extractionBackoffDelay` :

```ts
/**
 * Une photo de sortie n'est jamais reportée : l'utilisateur est devant la
 * bouteille et sort par la liste si l'analyse tarde. Deux tentatives rapprochées
 * couvrent un raté réseau ponctuel ; au-delà, la photo passe en échec et
 * l'écran bascule sur la recherche dans la cave.
 */
export const EXIT_ATTEMPTS = 2;
export const EXIT_RETRY_DELAY_MS = 3000;

export function jobOptionsFor(purpose: PhotoPurpose): JobsOptions {
  return purpose === 'EXIT' ? { attempts: EXIT_ATTEMPTS, backoff: { type: 'fixed', delay: EXIT_RETRY_DELAY_MS } } : {};
}
```

- [ ] **Step 4: Envoi avec destination**

Dans `api/src/photos/photos.service.ts` : importer `PhotoPurpose` depuis `@prisma/client` (`import { Photo, PhotoPurpose, Prisma } from '@prisma/client';`) et `jobOptionsFor` depuis `'../queue/extraction.queue'`. Changer la signature et la création :

```ts
  async ingest(input: Buffer, mimeType: string, purpose: PhotoPurpose = 'ENTRY'): Promise<{ photo: Photo; duplicate: boolean }> {
```

```ts
      photo = await this.prisma.photo.create({
        data: { id, contentHash, storagePath: normalizedPath, mimeType: 'image/jpeg', purpose },
      });
```

```ts
      await this.enqueueWithTimeout(photo.id, purpose);
```

```ts
  private async enqueueWithTimeout(photoId: string, purpose: PhotoPurpose): Promise<void> {
    let timer!: NodeJS.Timeout;
    try {
      await Promise.race([
        this.queue.add('extract', { photoId }, { jobId: photoId, ...jobOptionsFor(purpose) }),
```

Dans `queueStatus`, remplacer la ligne `where` par :

```ts
    const where: Prisma.PhotoWhereInput = { status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'ENTRY' };
```

Dans `listPendingReview`, remplacer `where: { status: 'DONE', movements: { none: {} } },` par :

```ts
      // Une photo de sortie analysée n'est pas un vin à rentrer.
      where: { status: 'DONE', purpose: 'ENTRY', movements: { none: {} } },
```

Dans `api/src/photos/photos.controller.ts`, importer `Body` dans la liste `@nestjs/common` et `z` depuis `'zod'`, puis :

```ts
const purposeSchema = z.enum(['ENTRY', 'EXIT']).default('ENTRY');
```

et dans `upload` :

```ts
  async upload(@UploadedFile() file?: Express.Multer.File, @Body('purpose') rawPurpose?: string) {
    if (!file) throw new BadRequestException('Fichier « file » manquant');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('Format d’image non pris en charge');
    const purpose = purposeSchema.safeParse(rawPurpose ?? undefined);
    if (!purpose.success) throw new BadRequestException('Destination de photo inconnue');
    const { photo, duplicate } = await this.photos.ingest(file.buffer, file.mimetype, purpose.data);
    return { id: photo.id, status: photo.status, duplicate };
  }
```

- [ ] **Step 5: Abandon au démarrage et message d'abandon**

Dans `api/src/queue/orphan-recovery.ts`, étendre l'interface et la boucle :

```ts
export interface OrphanRecoveryPrisma {
  photo: {
    findMany(args: unknown): Promise<{ id: string; purpose?: 'ENTRY' | 'EXIT' }[]>;
    update(args: unknown): Promise<unknown>;
  };
}
```

```ts
  const photos = await prisma.photo.findMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] } },
    select: { id: true, purpose: true },
    orderBy: { createdAt: 'asc' },
  });

  let requeued = 0;
  for (const { id, purpose } of photos) {
    // Une photo de sortie n'a de valeur que tant que l'utilisateur est devant la
    // bouteille : après un redémarrage, la sortie s'est faite autrement.
    if (purpose === 'EXIT') {
      await prisma.photo.update({ where: { id }, data: { status: 'FAILED', errorMessage: 'Photo de sortie abandonnée au redémarrage' } });
      continue;
    }
    const job = await queue.getJob(id);
```

(le reste de la boucle est inchangé).

Dans `api/src/queue/extraction.processor.ts`, importer `EXIT_ATTEMPTS` à côté de `EXTRACTION_ATTEMPTS`, puis remplacer la première ligne de `process` :

```ts
    const photo = await this.prisma.photo.update({ where: { id: photoId }, data: { status: 'PROCESSING' } });
    const attempts = photo.purpose === 'EXIT' ? EXIT_ATTEMPTS : EXTRACTION_ATTEMPTS;
```

et le message d'abandon :

```ts
        data: { status: 'FAILED', errorMessage: transient ? `${deferralReason(e)} — abandon après ${attempts} tentatives` : message },
```

- [ ] **Step 6: Lancer les tests**

Run: `cd api && npx jest && npm run lint && npx tsc --noEmit -p tsconfig.build.json`
Expected: PASS sur toutes les suites (les suites d'intégration restent ignorées sans base).

- [ ] **Step 7: Commit**

```bash
git add api/src/queue api/src/photos
git commit -m "feat(photos): photos de sortie, file courte et tenues hors de la revue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Reconnaissance à la sortie — similarité trigramme et classement

**Files:**
- Create: `api/src/wines/trigram.ts`, `api/src/wines/trigram.spec.ts`
- Create: `api/src/wines/exit-ranking.ts`, `api/src/wines/exit-ranking.spec.ts`

**Interfaces:**
- Consumes: `normalizeName` (`api/src/wines/match-key.ts`), `normalizeLabel` (`api/src/appellations/appellations.service.ts`).
- Produces:
  - `trigramSimilarity(a: string, b: string): number`
  - `interface ExitRead { producer: string | null; cuvee: string | null; appellation: string | null; vintage: number | null }`
  - `interface InStockWine { wine: { id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null; color: string; formatCl: number }; quantity: number; referencePhotoId: string | null }`
  - `type ExitOutcome = 'UNIQUE' | 'SEVERAL' | 'NONE'`
  - `interface ExitCandidate extends InStockWine { score: number }`
  - `rankExitCandidates(read: ExitRead, inStock: InStockWine[]): { outcome: ExitOutcome; candidates: ExitCandidate[] }`
  - constantes exportées `W_NAME`, `W_APPELLATION`, `VINTAGE_MATCH_BONUS`, `VINTAGE_MISMATCH_FACTOR`, `MIN_CANDIDATE_SCORE`, `UNIQUE_MIN_SCORE`, `UNIQUE_MIN_GAP`, `MAX_CANDIDATES`.

- [ ] **Step 1: Tests de la similarité**

`api/src/wines/trigram.spec.ts` :

```ts
import { trigramSimilarity } from './trigram';

describe('trigramSimilarity', () => {
  it('vaut 1 pour deux textes identiques', () => {
    expect(trigramSimilarity('tempier tourtine', 'tempier tourtine')).toBe(1);
  });

  it('vaut 0 quand un côté est vide', () => {
    expect(trigramSimilarity('', 'tempier')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });

  it('reprend la définition de pg_trgm : similarity(\'word\', \'two words\') = 0.363636…', () => {
    // Valeur documentée de PostgreSQL : 4 trigrammes communs sur 11 distincts.
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(4 / 11, 6);
  });

  it('est symétrique', () => {
    expect(trigramSimilarity('gauby vieilles vignes', 'gauby')).toBe(trigramSimilarity('gauby', 'gauby vieilles vignes'));
  });
});
```

- [ ] **Step 2: Tests du classement**

`api/src/wines/exit-ranking.spec.ts` :

```ts
import { InStockWine, rankExitCandidates } from './exit-ranking';

function w(id: string, producer: string, cuvee: string | null, appellationRaw: string, vintage: number | null, quantity = 3): InStockWine {
  return { wine: { id, producer, cuvee, appellationRaw, vintage, color: 'ROUGE', formatCl: 75 }, quantity, referencePhotoId: `ref-${id}` };
}

const cave: InStockWine[] = [
  w('tempier19', 'Domaine Tempier', 'La Tourtine', 'Bandol', 2019),
  w('tempier20', 'Domaine Tempier', 'La Tourtine', 'Bandol', 2020),
  w('tempierMig', 'Domaine Tempier', 'La Migoua', 'Bandol', 2019),
  w('beaucastel', 'Château de Beaucastel', null, 'Châteauneuf-du-Pape', 2016),
  w('gauby', 'Domaine Gauby', 'Vieilles Vignes', 'Côtes Catalanes', 2018),
  w('vide', 'Domaine Vide', null, 'Chablis', 2020, 0),
  w('margaux', 'Château Margaux', null, 'Margaux', 2010),
  w('palmer', 'Château Palmer', null, 'Margaux', 2010),
];
const ids = (r: ReturnType<typeof rankExitCandidates>) => r.candidates.map((c) => c.wine.id);

describe('rankExitCandidates', () => {
  it('reconnaît le bon millésime quand l’année est lue', () => {
    const r = rankExitCandidates({ producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: 2019 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('tempier19');
    expect(ids(r)).not.toContain('tempier20');
  });

  it('propose les deux millésimes quand l’année est illisible', () => {
    const r = rankExitCandidates({ producer: 'Tempier', cuvee: 'Tourtine', appellation: 'Bandol', vintage: null }, cave);
    expect(r.outcome).toBe('SEVERAL');
    expect(ids(r).slice(0, 2).sort()).toEqual(['tempier19', 'tempier20']);
  });

  it('ignore « Château », les accents et les tirets', () => {
    const r = rankExitCandidates({ producer: 'Beaucastel', cuvee: null, appellation: 'Chateauneuf du Pape', vintage: 2016 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('beaucastel');
  });

  it('ne trouve rien pour un vin absent de la cave', () => {
    const r = rankExitCandidates({ producer: 'Domaine Rostaing', cuvee: 'Côte Blonde', appellation: 'Côte-Rôtie', vintage: 2017 }, cave);
    expect(r).toEqual({ outcome: 'NONE', candidates: [] });
  });

  it('distingue deux cuvées du même domaine', () => {
    const r = rankExitCandidates({ producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol', vintage: 2019 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('tempierMig');
  });

  it('ne propose jamais un vin à zéro bouteille', () => {
    const r = rankExitCandidates({ producer: 'Domaine Vide', cuvee: null, appellation: 'Chablis', vintage: 2020 }, cave);
    expect(ids(r)).not.toContain('vide');
  });

  it('se contente du nom quand l’appellation est illisible', () => {
    const r = rankExitCandidates({ producer: 'Domaine Gauby', cuvee: 'Vieilles Vignes', appellation: null, vintage: 2018 }, cave);
    expect(r.outcome).toBe('UNIQUE');
    expect(ids(r)[0]).toBe('gauby');
  });

  it('départage deux châteaux de la même appellation par leur nom', () => {
    const r = rankExitCandidates({ producer: 'Château Palmer', cuvee: null, appellation: 'Margaux', vintage: 2010 }, cave);
    expect(ids(r)[0]).toBe('palmer');
  });

  it('montre en vignette un candidat seul mais peu sûr, sans le confirmer d’office', () => {
    const r = rankExitCandidates({ producer: 'Tempier', cuvee: null, appellation: null, vintage: null }, [w('t', 'Domaine Tempier', 'La Tourtine', 'Bandol', 2019)]);
    expect(r.candidates).toHaveLength(1);
    expect(r.outcome).toBe('SEVERAL');
  });

  it('ne renvoie jamais plus de quatre candidats', () => {
    const many = [2015, 2016, 2017, 2018, 2019, 2020].map((y) => w(`t${y}`, 'Domaine Tempier', 'La Tourtine', 'Bandol', y));
    const r = rankExitCandidates({ producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: null }, many);
    expect(r.candidates).toHaveLength(4);
  });

  it('ne trouve rien quand le modèle n’a rien lu', () => {
    expect(rankExitCandidates({ producer: null, cuvee: null, appellation: null, vintage: null }, cave).outcome).toBe('NONE');
  });
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

Run: `cd api && npx jest src/wines/trigram.spec.ts src/wines/exit-ranking.spec.ts`
Expected: FAIL — « Cannot find module './trigram' » et « './exit-ranking' ».

- [ ] **Step 4: Implémenter la similarité**

`api/src/wines/trigram.ts` :

```ts
/**
 * Similarité trigramme, définition de pg_trgm : chaque mot est complété de deux
 * espaces devant et d'un derrière, découpé en trigrammes, et la similarité est
 * le rapport entre trigrammes communs et trigrammes distincts des deux côtés.
 *
 * Calculée en mémoire plutôt qu'en SQL : la sortie compare une lecture à
 * quelques centaines de vins au plus, et une fonction pure se teste sans base.
 * Les entrées doivent déjà être normalisées (minuscules, sans accents).
 */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(' ')) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / (ta.size + tb.size - common);
}
```

- [ ] **Step 5: Implémenter le classement**

`api/src/wines/exit-ranking.ts` :

```ts
import { normalizeLabel } from '../appellations/appellations.service';
import { normalizeName } from './match-key';
import { trigramSimilarity } from './trigram';

// Valeurs initiales de la spécification du lot 2a, calées sur les cas de
// exit-ranking.spec.ts. Les modifier, c'est rejouer ces cas d'abord.
export const W_NAME = 0.6;
export const W_APPELLATION = 0.4;
export const VINTAGE_MATCH_BONUS = 0.25;
export const VINTAGE_MISMATCH_FACTOR = 0.3;
export const MIN_CANDIDATE_SCORE = 0.35;
export const UNIQUE_MIN_SCORE = 0.6;
export const UNIQUE_MIN_GAP = 0.15;
export const MAX_CANDIDATES = 4;

export interface ExitRead {
  producer: string | null;
  cuvee: string | null;
  appellation: string | null;
  vintage: number | null;
}

export interface InStockWine {
  wine: { id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null; color: string; formatCl: number };
  quantity: number;
  referencePhotoId: string | null;
}

export type ExitOutcome = 'UNIQUE' | 'SEVERAL' | 'NONE';

export interface ExitCandidate extends InStockWine {
  score: number;
}

function nameOf(producer: string | null, cuvee: string | null): string {
  return `${normalizeName(producer)} ${normalizeName(cuvee)}`.trim();
}

/**
 * Classe les vins en stock face à ce que le modèle a lu sur l'étiquette.
 *
 * Le millésime pèse lourd : c'est le seul discriminant entre deux millésimes du
 * même vin, cas le plus fréquent d'une cave. Égal, il ajoute un bonus ; connu des
 * deux côtés et différent, il écrase le score ; illisible, il est neutre — et
 * c'est alors à l'utilisateur de départager sur les vignettes.
 *
 * Un candidat n'est déclaré UNIQUE que s'il est à la fois sûr et nettement
 * devant : sinon il est montré en vignette, jamais confirmé d'office.
 */
export function rankExitCandidates(read: ExitRead, inStock: InStockWine[]): { outcome: ExitOutcome; candidates: ExitCandidate[] } {
  const readName = nameOf(read.producer, read.cuvee);
  const readAppellation = read.appellation ? normalizeLabel(read.appellation) : '';
  if (!readName && !readAppellation) return { outcome: 'NONE', candidates: [] };

  const scored: ExitCandidate[] = inStock
    .filter((s) => s.quantity > 0)
    .map((s) => {
      const nameScore = trigramSimilarity(readName, nameOf(s.wine.producer, s.wine.cuvee));
      let score = readAppellation
        ? W_NAME * nameScore + W_APPELLATION * trigramSimilarity(readAppellation, normalizeLabel(s.wine.appellationRaw))
        : nameScore;
      if (read.vintage != null && s.wine.vintage != null) {
        score = read.vintage === s.wine.vintage ? score + VINTAGE_MATCH_BONUS : score * VINTAGE_MISMATCH_FACTOR;
      }
      return { ...s, score: Math.round(score * 1000) / 1000 };
    })
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  if (scored.length === 0) return { outcome: 'NONE', candidates: [] };
  const [first, second] = scored;
  const unique = first.score >= UNIQUE_MIN_SCORE && (!second || first.score - second.score >= UNIQUE_MIN_GAP);
  return { outcome: unique ? 'UNIQUE' : 'SEVERAL', candidates: scored };
}
```

- [ ] **Step 6: Lancer les tests**

Run: `cd api && npx jest src/wines/ && npm run lint`
Expected: PASS (15 tests dans les deux nouveaux fichiers, suites existantes inchangées).

- [ ] **Step 7: Commit**

```bash
git add api/src/wines/trigram.ts api/src/wines/trigram.spec.ts api/src/wines/exit-ranking.ts api/src/wines/exit-ranking.spec.ts
git commit -m "feat(sortie): classer les vins en stock face à l'étiquette lue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mouvements — sortie, inventaire, photo de référence à l'entrée

**Files:**
- Modify: `api/src/movements/dto.ts`
- Modify: `api/src/movements/movements.service.ts`, `api/src/movements/movements.service.spec.ts`
- Modify: `api/src/movements/movements.controller.ts`
- Create: `api/src/movements/inventory.integration.spec.ts`

**Interfaces:**
- Consumes: index `idx_movement_photo_out` et déclencheur verrouillé (tâche 1).
- Produces:
  - `createOutSchema` / `type CreateOutInput = { idempotencyKey: string; wineId: string; quantity: number; photoId?: string | null }`
  - `inventorySchema` / `type InventoryInput = { idempotencyKey: string; counted: number }`
  - `MovementsService.createOut(input: CreateOutInput): Promise<MovementResult>` — `409` « Il n'en reste que N » ; une photo déjà utilisée renvoie la première sortie (`created: false`).
  - `interface InventoryResult { movement: Movement | null; stock: number; delta: number; created: boolean }`
  - `MovementsService.adjustTo(wineId: string, input: InventoryInput): Promise<InventoryResult>`
  - `POST /movements/out`

- [ ] **Step 1: Tests qui échouent**

Dans `api/src/movements/movements.service.spec.ts`, étendre le harnais existant : dans l'objet `prisma.movement`, remplacer `findFirst` par une version qui comprend aussi `photoId`/`type`, et ajouter `wine.update`, `wine.findUnique` et `$transaction` :

```ts
      findFirst: async ({ where, include }: any) => {
        const m =
          movements.find((x) =>
            where.reversesId !== undefined ? x.reversesId === where.reversesId : x.photoId === where.photoId && x.type === where.type,
          ) ?? null;
        return m && include?.wine ? { ...m, wine } : m;
      },
    },
    wine: {
      findUnique: async ({ where }: any) => (where.id === wine.id ? wine : null),
      update: jest.fn(async ({ data }: any) => Object.assign(wine, data)),
    },
    $transaction: async (fn: any) => fn(prisma),
    $queryRaw: async () => [{ quantity: stock() }],
```

(le `$queryRaw` existant est conservé tel quel ; déclarer l'objet avec `const prisma: any = { … }` pour que `$transaction` puisse se référencer). Exposer `wine` dans le retour : `return { movements, wine, prisma, service: new MovementsService(prisma as any, matching as any) };`.

Ajouter ensuite :

```ts
describe('MovementsService.createOut', () => {
  const out = { idempotencyKey: 'o1', wineId: 'w1', quantity: 1 };

  it('écrit une sortie négative et renvoie le stock restant', async () => {
    const h = harness();
    await h.service.createIn(input);
    const r = await h.service.createOut(out);
    expect(r.movement.type).toBe('OUT');
    expect(r.movement.delta).toBe(-1);
    expect(r.stock).toBe(5);
    expect(r.created).toBe(true);
  });

  it('est idempotente sur la clé', async () => {
    const h = harness();
    await h.service.createIn(input);
    await h.service.createOut(out);
    const again = await h.service.createOut({ ...out, quantity: 3 });
    expect(again.created).toBe(false);
    expect(again.stock).toBe(5);
  });

  it('refuse en 409 lisible une sortie supérieure au stock', async () => {
    const h = harness();
    await h.service.createIn({ ...input, quantity: 2 });
    await expect(h.service.createOut({ ...out, quantity: 3 })).rejects.toThrow(new ConflictException('Il n’en reste que 2'));
  });

  it('renvoie la première sortie quand la même photo sert une seconde fois, sans redébiter', async () => {
    const h = harness();
    await h.service.createIn(input);
    const first = await h.service.createOut({ ...out, photoId: 'p-exit' });
    const second = await h.service.createOut({ ...out, idempotencyKey: 'o2', photoId: 'p-exit' });
    expect(second.created).toBe(false);
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.stock).toBe(5);
  });

  it('refuse une quantité nulle ou négative', async () => {
    const h = harness();
    await expect(h.service.createOut({ ...out, quantity: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('répond 404 pour un vin inconnu', async () => {
    const h = harness();
    await expect(h.service.createOut({ ...out, wineId: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MovementsService.adjustTo', () => {
  it('écrit l’écart d’inventaire comme un ADJUST daté', async () => {
    const h = harness();
    await h.service.createIn(input); // stock 6
    const r = await h.service.adjustTo('w1', { idempotencyKey: 'inv1', counted: 4 });
    expect(r).toMatchObject({ delta: -2, stock: 4, created: true });
    expect(r.movement).toMatchObject({ type: 'ADJUST', delta: -2, note: 'Inventaire : 4 comptées' });
  });

  it('n’écrit rien quand le stock est déjà juste', async () => {
    const h = harness();
    await h.service.createIn(input);
    const r = await h.service.adjustTo('w1', { idempotencyKey: 'inv2', counted: 6 });
    expect(r).toEqual({ movement: null, stock: 6, delta: 0, created: false });
    expect(h.movements).toHaveLength(1);
  });

  it('accepte un inventaire supérieur au stock théorique', async () => {
    const h = harness();
    await h.service.createIn(input);
    expect((await h.service.adjustTo('w1', { idempotencyKey: 'inv3', counted: 8 })).delta).toBe(2);
  });

  it('est idempotent sur la clé', async () => {
    const h = harness();
    await h.service.createIn(input);
    await h.service.adjustTo('w1', { idempotencyKey: 'inv4', counted: 4 });
    const again = await h.service.adjustTo('w1', { idempotencyKey: 'inv4', counted: 4 });
    expect(again.created).toBe(false);
    expect(h.movements).toHaveLength(2);
  });

  it('répond 404 pour un vin inconnu', async () => {
    const h = harness();
    await expect(h.service.adjustTo('nope', { idempotencyKey: 'inv5', counted: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MovementsService.createIn — photo de référence', () => {
  it('retient la photo de la première entrée comme photo de référence du vin', async () => {
    const h = harness();
    await h.service.createIn({ ...input, photoId: 'p-in' });
    expect(h.wine.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { referencePhotoId: 'p-in' } });
  });

  it('ne remplace pas une photo de référence déjà posée', async () => {
    const h = harness();
    (h.wine as any).referencePhotoId = 'p-old';
    await h.service.createIn({ ...input, photoId: 'p-in' });
    expect(h.wine.update).not.toHaveBeenCalled();
  });
});
```

Mettre à jour l'import en tête : `import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';`.

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `cd api && npx jest src/movements/movements.service.spec.ts`
Expected: FAIL — « h.service.createOut is not a function », « adjustTo is not a function », `wine.update` jamais appelé.

- [ ] **Step 3: Schémas d'entrée**

À la fin de `api/src/movements/dto.ts` :

```ts
export const createOutSchema = z.object({
  idempotencyKey: z.string().uuid('idempotencyKey invalide'),
  wineId: z.string().uuid('Vin invalide'),
  quantity: z.number().int().positive('La quantité doit être positive'),
  photoId: z.string().uuid().nullish(),
});

export type CreateOutInput = z.infer<typeof createOutSchema>;

export const inventorySchema = z.object({
  idempotencyKey: z.string().uuid('idempotencyKey invalide'),
  counted: z.number({ invalid_type_error: 'Nombre de bouteilles invalide' }).int('Nombre de bouteilles entier attendu').min(0, 'Le nombre de bouteilles ne peut pas être négatif'),
});

export type InventoryInput = z.infer<typeof inventorySchema>;
```

- [ ] **Step 4: Service**

Dans `api/src/movements/movements.service.ts`, importer `CreateOutInput, InventoryInput` depuis `./dto`, et ajouter après `MovementResult` :

```ts
export interface InventoryResult {
  movement: Movement | null;
  stock: number;
  delta: number;
  created: boolean;
}
```

Dans `createIn`, juste après `const movement = await this.prisma.movement.create({ … });` et avant le `return` :

```ts
      // La première photo d'entrée devient la vignette du vin : c'est elle qui
      // permet de départager deux millésimes à la sortie.
      if (input.photoId && !wine.referencePhotoId) {
        await this.prisma.wine.update({ where: { id: wine.id }, data: { referencePhotoId: input.photoId } });
      }
```

Ajouter les deux méthodes avant `recent` :

```ts
  async createOut(input: CreateOutInput): Promise<MovementResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité doit être un entier positif');
    }
    const replay = await this.findOutReplay(input);
    if (replay) return replay;

    const wine = await this.prisma.wine.findUnique({ where: { id: input.wineId } });
    if (!wine) throw new NotFoundException('Vin introuvable');

    try {
      const movement = await this.prisma.movement.create({
        data: {
          wineId: wine.id,
          delta: -input.quantity,
          type: 'OUT',
          photoId: input.photoId ?? null,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { movement, wine, stock: await this.stockOf(wine.id), created: true };
    } catch (e) {
      // Course perdue contre un double tap ou un second téléphone : la clé ou la
      // photo a été écrite entre la vérification et l'insertion.
      // Toute violation d'unicité, sans se fier au nom d'index que Prisma remonte
      // pour un index partiel écrit à la main.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.findOutReplay(input);
        if (raced) return raced;
      }
      if (e instanceof Error && /aucune bouteille/.test(e.message)) {
        throw new ConflictException(`Il n’en reste que ${await this.stockOf(wine.id)}`);
      }
      throw e;
    }
  }

  /** Une même clé, ou une même photo, ne débite qu'une fois : on renvoie la première sortie. */
  private async findOutReplay(input: CreateOutInput): Promise<MovementResult | null> {
    const byKey = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } });
    const byPhoto =
      byKey ?? (input.photoId ? await this.prisma.movement.findFirst({ where: { photoId: input.photoId, type: 'OUT' }, include: { wine: true } }) : null);
    if (!byPhoto) return null;
    const { wine, ...movement } = byPhoto;
    return { movement, wine, stock: await this.stockOf(byPhoto.wineId), created: false };
  }

  /**
   * Inventaire physique : l'utilisateur a compté N bouteilles, l'écart avec le
   * journal devient un mouvement ADJUST daté. Le verrou sur la ligne du vin
   * empêche deux inventaires simultanés de calculer leur écart sur le même stock.
   */
  async adjustTo(wineId: string, input: InventoryInput): Promise<InventoryResult> {
    const already = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (already) return { movement: already, stock: await this.stockOf(wineId), delta: already.delta, created: false };

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM wine WHERE id = ${wineId} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Vin introuvable');
      const [{ quantity }] = await tx.$queryRaw<{ quantity: number }[]>`
        SELECT COALESCE(SUM(delta), 0)::INTEGER AS quantity FROM movement WHERE wine_id = ${wineId}`;
      const delta = input.counted - quantity;
      if (delta === 0) return { movement: null, stock: quantity, delta: 0, created: false };
      const movement = await tx.movement.create({
        data: { wineId, delta, type: 'ADJUST', note: `Inventaire : ${input.counted} comptées`, idempotencyKey: input.idempotencyKey },
      });
      return { movement, stock: input.counted, delta, created: true };
    });
  }
```

Le harnais de test répond à `$queryRaw` par `[{ quantity: stock() }]` pour toutes les requêtes brutes : pour que le verrou trouve le vin, faire répondre `$queryRaw` selon le texte de la requête :

```ts
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('?').includes('FOR UPDATE') ? (values[0] === wine.id ? [{ id: wine.id }] : []) : [{ quantity: stock() }],
```

- [ ] **Step 5: Contrôleur**

Dans `api/src/movements/movements.controller.ts`, importer `createOutSchema` depuis `./dto` et ajouter avant `@Post(':id/cancel')` :

```ts
  @Post('out')
  createOut(@Body() body: unknown) {
    const parsed = createOutSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.createOut(parsed.data);
  }
```

- [ ] **Step 6: Test d'intégration de l'inventaire concurrent**

`api/src/movements/inventory.integration.spec.ts` :

```ts
import { PrismaClient, WineColor } from '@prisma/client';
import { MovementsService } from './movements.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('inventaire sous concurrence (base réelle)', () => {
  const prisma = new PrismaClient();
  const service = new MovementsService(prisma as never, {} as never);
  let wineId: string;

  beforeAll(async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `inv|${Date.now()}`, producer: 'Domaine Inventaire', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineId = wine.id;
    await prisma.movement.create({ data: { wineId, delta: 6, type: 'IN', idempotencyKey: `inv-in-${Date.now()}` } });
  });

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { wineId } });
    await prisma.wine.delete({ where: { id: wineId } });
    await prisma.$disconnect();
  });

  it('deux inventaires simultanés du même compte n’écrivent l’écart qu’une fois', async () => {
    // Sans verrou, les deux calculeraient −2 sur un stock de 6 et laisseraient 2.
    const [a, b] = await Promise.all([
      service.adjustTo(wineId, { idempotencyKey: crypto.randomUUID(), counted: 4 }),
      service.adjustTo(wineId, { idempotencyKey: crypto.randomUUID(), counted: 4 }),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const sum = await prisma.movement.aggregate({ _sum: { delta: true }, where: { wineId } });
    expect(sum._sum.delta).toBe(4);
  });
});
```

- [ ] **Step 7: Lancer les tests**

Run: `cd api && npx jest && npm run lint && npx tsc --noEmit -p tsconfig.build.json`
Expected: PASS (la suite d'intégration est ignorée sans `DATABASE_URL` ; elle tourne en CI).

- [ ] **Step 8: Commit**

```bash
git add api/src/movements
git commit -m "feat(sortie): sortie de stock, inventaire physique et photo de référence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Module Cave — liste, fiche, inventaire, candidats de sortie

**Files:**
- Create: `api/src/cave/cave-filter.ts`, `api/src/cave/cave-filter.spec.ts`
- Create: `api/src/cave/cave.service.ts`, `api/src/cave/cave.service.spec.ts`
- Create: `api/src/cave/cave.controller.ts`, `api/src/cave/cave.module.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Consumes: `rankExitCandidates`, `InStockWine`, `ExitRead` (tâche 3) ; `MovementsService.adjustTo`, `inventorySchema` (tâche 4) ; `parseExtraction` (`api/src/vision/extraction-schema.ts`).
- Produces (formes JSON consommées par le web, tâche 6) :
  - `interface CaveRow { id; producer; cuvee: string | null; appellationRaw; vintage: number | null; color: string; formatCl: number; referencePhotoId: string | null; quantity: number }`
  - `filterCave(rows: CaveRow[], filter: { q?: string; color?: string; includeEmpty?: boolean }): CaveRow[]`
  - `GET /cave` → `CaveRow[]`
  - `GET /wines/:id` → `{ wine: CaveRow; movements: Array<{ id; delta; type; occurredAt; note; reversesId }> }`
  - `POST /wines/:id/inventory` → `InventoryResult`
  - `GET /photos/:id/exit-candidates` → `{ status: 'PENDING' | 'PROCESSING' } | { status: 'FAILED'; errorMessage: string | null } | { status: 'DONE'; outcome; read: ExitRead; candidates: ExitCandidate[] }`

- [ ] **Step 1: Tests du filtre**

`api/src/cave/cave-filter.spec.ts` :

```ts
import { CaveRow, filterCave } from './cave-filter';

const row = (id: string, producer: string, appellationRaw: string, quantity: number, extra: Partial<CaveRow> = {}): CaveRow => ({
  id, producer, cuvee: null, appellationRaw, vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity, ...extra,
});

const rows = [
  row('a', 'Château de Beaucastel', 'Châteauneuf-du-Pape', 3),
  row('b', 'Domaine Tempier', 'Bandol', 0),
  row('c', 'Domaine Leflaive', 'Puligny-Montrachet', 2, { color: 'BLANC', cuvee: 'Clavoillon' }),
];

describe('filterCave', () => {
  it('masque les vins épuisés par défaut', () => {
    expect(filterCave(rows, {}).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('les montre sur demande', () => {
    expect(filterCave(rows, { includeEmpty: true }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('cherche sans tenir compte des accents ni de la casse', () => {
    expect(filterCave(rows, { q: 'chateauneuf' }).map((r) => r.id)).toEqual(['a']);
  });

  it('cherche aussi dans la cuvée', () => {
    expect(filterCave(rows, { q: 'CLAVOILLON' }).map((r) => r.id)).toEqual(['c']);
  });

  it('exige tous les mots de la recherche', () => {
    expect(filterCave(rows, { q: 'leflaive puligny' }).map((r) => r.id)).toEqual(['c']);
    expect(filterCave(rows, { q: 'leflaive bandol' })).toEqual([]);
  });

  it('filtre par couleur', () => {
    expect(filterCave(rows, { color: 'BLANC' }).map((r) => r.id)).toEqual(['c']);
  });
});
```

- [ ] **Step 2: Tests du service**

`api/src/cave/cave.service.spec.ts` :

```ts
import { NotFoundException } from '@nestjs/common';
import { CaveRow } from './cave-filter';
import { CaveService } from './cave.service';

const tempier19: CaveRow = {
  id: 'w19', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019,
  color: 'ROUGE', formatCl: 75, referencePhotoId: 'ref19', quantity: 2,
};
const raw = (vintage: number | null) => ({
  producteur: { value: 'Domaine Tempier', confidence: 0.9 }, cuvee: { value: 'La Tourtine', confidence: 0.9 },
  appellation: { value: 'Bandol', confidence: 0.9 }, millesime: { value: vintage, confidence: vintage ? 0.9 : 0 },
  couleur: { value: 'rouge', confidence: 0.9 }, format_cl: { value: 75, confidence: 0.9 }, degre: { value: null, confidence: 0 },
  pays_region: { value: null, confidence: 0 }, nb_cols_carton: { value: null, confidence: 0 }, confiance_globale: 0.9,
});

function service(photo: any, rows: CaveRow[] = [tempier19]) {
  const prisma = {
    $queryRaw: jest.fn(async () => rows),
    photo: { findUnique: jest.fn(async () => photo) },
    movement: { findMany: jest.fn(async () => []) },
  };
  return new CaveService(prisma as any);
}

describe('CaveService.exitCandidates', () => {
  it('répond 404 pour une photo inconnue', async () => {
    await expect(service(null).exitCandidates('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dit que l’analyse est en cours tant que la photo n’est pas lue', async () => {
    expect(await service({ status: 'PROCESSING' }).exitCandidates('p')).toEqual({ status: 'PROCESSING' });
  });

  it('transmet l’échec de l’analyse', async () => {
    expect(await service({ status: 'FAILED', errorMessage: 'saturé' }).exitCandidates('p')).toEqual({ status: 'FAILED', errorMessage: 'saturé' });
  });

  it('classe les vins en stock et renvoie ce que le modèle a lu', async () => {
    const r = await service({ status: 'DONE', purpose: 'EXIT', rawExtraction: raw(2019) }).exitCandidates('p');
    expect(r).toMatchObject({ status: 'DONE', outcome: 'UNIQUE', read: { producer: 'Domaine Tempier', vintage: 2019 } });
    expect((r as any).candidates[0].wine.id).toBe('w19');
    expect((r as any).candidates[0].referencePhotoId).toBe('ref19');
  });

  it('fonctionne aussi sur une photo d’entrée réutilisée par la déduplication', async () => {
    const r = await service({ status: 'DONE', purpose: 'ENTRY', rawExtraction: raw(2019) }).exitCandidates('p');
    expect((r as any).outcome).toBe('UNIQUE');
  });

  it('traite une extraction illisible comme un échec, jamais comme un vin', async () => {
    expect(await service({ status: 'DONE', rawExtraction: { n: 'importe quoi' } }).exitCandidates('p')).toEqual({
      status: 'FAILED',
      errorMessage: 'Lecture de l’étiquette inexploitable',
    });
  });
});

describe('CaveService.detail', () => {
  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, []).detail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renvoie le vin avec son stock et ses derniers mouvements', async () => {
    const r = await service(null).detail('w19');
    expect(r.wine).toEqual(tempier19);
    expect(r.movements).toEqual([]);
  });
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

Run: `cd api && npx jest src/cave/`
Expected: FAIL — « Cannot find module './cave-filter' » et « './cave.service' ».

- [ ] **Step 4: Filtre**

`api/src/cave/cave-filter.ts` :

```ts
import { normalizeLabel } from '../appellations/appellations.service';

export interface CaveRow {
  id: string;
  producer: string;
  cuvee: string | null;
  appellationRaw: string;
  vintage: number | null;
  color: string;
  formatCl: number;
  referencePhotoId: string | null;
  quantity: number;
}

export interface CaveFilter {
  q?: string;
  color?: string;
  includeEmpty?: boolean;
}

/** Tous les mots cherchés doivent apparaître, sans accents ni casse, dans producteur, cuvée ou appellation. */
export function filterCave(rows: CaveRow[], filter: CaveFilter): CaveRow[] {
  const words = normalizeLabel(filter.q ?? '').split(' ').filter(Boolean);
  return rows.filter((r) => {
    if (!filter.includeEmpty && r.quantity <= 0) return false;
    if (filter.color && r.color !== filter.color) return false;
    const haystack = normalizeLabel(`${r.producer} ${r.cuvee ?? ''} ${r.appellationRaw}`);
    return words.every((w) => haystack.includes(w));
  });
}
```

- [ ] **Step 5: Service**

`api/src/cave/cave.service.ts` :

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseExtraction } from '../vision/extraction-schema';
import { ExitCandidate, ExitOutcome, ExitRead, rankExitCandidates } from '../wines/exit-ranking';
import { CaveFilter, CaveRow, filterCave } from './cave-filter';

export type ExitCandidatesResponse =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'FAILED'; errorMessage: string | null }
  | { status: 'DONE'; outcome: ExitOutcome; read: ExitRead; candidates: ExitCandidate[] };

@Injectable()
export class CaveService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tous les vins avec leur stock. Lu en une requête puis filtré en mémoire : la
   * cave compte quelques centaines de références, et le filtre se teste ainsi
   * sans base.
   */
  allWithStock(): Promise<CaveRow[]> {
    return this.prisma.$queryRaw<CaveRow[]>`
      SELECT w.id, w.producer, w.cuvee, w.appellation_raw AS "appellationRaw", w.vintage,
             w.color::TEXT AS color, w.format_cl AS "formatCl", w.reference_photo_id AS "referencePhotoId",
             COALESCE(s.quantity, 0)::INTEGER AS quantity
      FROM wine w LEFT JOIN stock_courant s ON s.wine_id = w.id
      ORDER BY w.producer ASC, w.vintage ASC NULLS FIRST`;
  }

  async list(filter: CaveFilter): Promise<CaveRow[]> {
    return filterCave(await this.allWithStock(), filter);
  }

  async detail(id: string) {
    const wine = (await this.allWithStock()).find((r) => r.id === id);
    if (!wine) throw new NotFoundException('Vin introuvable');
    const movements = await this.prisma.movement.findMany({
      where: { wineId: id },
      orderBy: { occurredAt: 'desc' },
      take: 10,
      select: { id: true, delta: true, type: true, occurredAt: true, note: true, reversesId: true },
    });
    return { wine, movements };
  }

  async exitCandidates(photoId: string): Promise<ExitCandidatesResponse> {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    if (photo.status === 'PENDING' || photo.status === 'PROCESSING') return { status: photo.status };
    if (photo.status === 'FAILED') return { status: 'FAILED', errorMessage: photo.errorMessage ?? null };

    let read: ExitRead;
    try {
      const e = parseExtraction(photo.rawExtraction);
      read = { producer: e.producer.value, cuvee: e.cuvee.value, appellation: e.appellation.value, vintage: e.vintage.value };
    } catch {
      // Un prix faux est pire qu'un prix absent ; une sortie fausse aussi : une
      // lecture inexploitable renvoie vers la liste, jamais vers un vin deviné.
      return { status: 'FAILED', errorMessage: 'Lecture de l’étiquette inexploitable' };
    }
    const inStock = (await this.allWithStock())
      .filter((r) => r.quantity > 0)
      .map(({ quantity, referencePhotoId, ...wine }) => ({ wine, quantity, referencePhotoId }));
    return { status: 'DONE', read, ...rankExitCandidates(read, inStock) };
  }
}
```

(Dans le test `detail`, le harnais renvoie `rows` pour `$queryRaw` ; le vin `w19` est trouvé, `nope` ne l'est pas — `service(null, [])` renvoie une liste vide.)

- [ ] **Step 6: Contrôleur et module**

`api/src/cave/cave.controller.ts` :

```ts
import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { inventorySchema } from '../movements/dto';
import { MovementsService } from '../movements/movements.service';
import { CaveService } from './cave.service';

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']).optional(),
  includeEmpty: z.enum(['true', 'false']).optional(),
});

@Controller()
@UseGuards(AuthenticatedGuard)
export class CaveController {
  constructor(
    private readonly cave: CaveService,
    private readonly movements: MovementsService,
  ) {}

  @Get('cave')
  list(@Query() query: unknown) {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Filtre de cave invalide');
    return this.cave.list({ q: parsed.data.q, color: parsed.data.color, includeEmpty: parsed.data.includeEmpty === 'true' });
  }

  @Get('wines/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.detail(id);
  }

  @Post('wines/:id/inventory')
  inventory(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = inventorySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.adjustTo(id, parsed.data);
  }

  @Get('photos/:id/exit-candidates')
  exitCandidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.exitCandidates(id);
  }
}
```

`api/src/cave/cave.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MovementsModule } from '../movements/movements.module';
import { CaveController } from './cave.controller';
import { CaveService } from './cave.service';

@Module({ imports: [AuthModule, MovementsModule], controllers: [CaveController], providers: [CaveService] })
export class CaveModule {}
```

Dans `api/src/app.module.ts`, importer `CaveModule` (`import { CaveModule } from './cave/cave.module';`) et l'ajouter à la fin du tableau `imports`, après `ExportModule`.

- [ ] **Step 7: Lancer les tests**

Run: `cd api && npx jest && npm run lint && npx tsc --noEmit -p tsconfig.build.json && npm run build`
Expected: PASS ; le build Nest réussit (vérifie l'injection des modules).

- [ ] **Step 8: Commit**

```bash
git add api/src/cave api/src/app.module.ts
git commit -m "feat(cave): liste, fiche vin, inventaire et candidats de sortie

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — client d'API, onglet Cave, vignettes

**Files:**
- Modify: `web/src/lib/api-client.ts`
- Create: `web/src/components/WineThumb.tsx`
- Create: `web/src/pages/CavePage.tsx`, `web/src/pages/CavePage.test.tsx`
- Modify: `web/src/router.tsx`, `web/src/components/BottomNav.tsx`, `web/src/styles/base.css`

**Interfaces:**
- Consumes: routes de la tâche 5 et `POST /movements/out` (tâche 4).
- Produces (dans `api-client.ts`) :
  - `interface CaveRow` (identique à l'API), `getCave(filter: { q?: string; color?: WineColor; includeEmpty?: boolean }): Promise<CaveRow[]>`
  - `interface WineDetail { wine: CaveRow; movements: Array<{ id: string; delta: number; type: 'IN' | 'OUT' | 'ADJUST'; occurredAt: string; note: string | null; reversesId: string | null }> }`, `getWine(id: string): Promise<WineDetail>`
  - `createOut(input: { idempotencyKey: string; wineId: string; quantity: number; photoId?: string | null }): Promise<MovementResult>`
  - `interface InventoryResult { movement: { id: string } | null; stock: number; delta: number; created: boolean }`, `postInventory(wineId: string, input: { idempotencyKey: string; counted: number }): Promise<InventoryResult>`
  - `interface ExitRead`, `interface ExitCandidate { wine: Omit<CaveRow, 'quantity' | 'referencePhotoId'>; quantity: number; referencePhotoId: string | null; score: number }`, `type ExitCandidatesResponse`, `getExitCandidates(photoId: string): Promise<ExitCandidatesResponse>`
  - `uploadPhoto(file: File | Blob, purpose: 'ENTRY' | 'EXIT' = 'ENTRY')`
  - composant `WineThumb({ photoId, size }: { photoId: string | null; size?: number })`

- [ ] **Step 1: Test de la page Cave**

`web/src/pages/CavePage.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { CavePage } from './CavePage';

afterEach(() => vi.restoreAllMocks());

const rows: api.CaveRow[] = [
  { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 3 },
  { id: 'w2', producer: 'Domaine Leflaive', cuvee: null, appellationRaw: 'Puligny-Montrachet', vintage: 2020, color: 'BLANC', formatCl: 75, referencePhotoId: null, quantity: 1 },
];

function mount(url = '/cave') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/cave" element={<CavePage />} />
          <Route path="/cave/:wineId" element={<p>Fiche</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('liste les vins en stock avec leur quantité et un lien vers la fiche', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  expect(await screen.findByText(/Domaine Tempier/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Domaine Tempier.*2019/ })).toHaveAttribute('href', '/cave/w1');
  expect(screen.getByText('3')).toBeInTheDocument();
});

it('affiche un pictogramme, jamais une image cassée, pour un vin sans photo', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  const { container } = mount();
  await screen.findByText(/Domaine Leflaive/);
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(screen.getByLabelText('Pas de photo')).toBeInTheDocument();
});

it('transmet la recherche pré-remplie par l’URL', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount('/cave?q=tempier');
  await waitFor(() => expect(getCave).toHaveBeenCalledWith({ q: 'tempier', color: undefined, includeEmpty: false }));
  expect(screen.getByRole('searchbox')).toHaveValue('tempier');
});

it('filtre par couleur et montre les épuisés sur demande', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  await screen.findByText(/Domaine Tempier/);
  await userEvent.selectOptions(screen.getByLabelText('Couleur'), 'BLANC');
  await userEvent.click(screen.getByLabelText('Afficher les vins épuisés'));
  await waitFor(() => expect(getCave).toHaveBeenLastCalledWith({ q: '', color: 'BLANC', includeEmpty: true }));
});

it('dit quand la cave est vide', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount();
  expect(await screen.findByText(/Aucun vin ne correspond/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

Run: `cd web && npx vitest run src/pages/CavePage.test.tsx`
Expected: FAIL — « Failed to resolve import "./CavePage" ».

- [ ] **Step 3: Client d'API**

Dans `web/src/lib/api-client.ts`, remplacer `uploadPhoto` par :

```ts
export function uploadPhoto(file: File | Blob, purpose: 'ENTRY' | 'EXIT' = 'ENTRY') {
  const form = new FormData();
  form.append('file', file, 'photo.jpg');
  form.append('purpose', purpose);
  return apiFetch<{ id: string; status: string; duplicate: boolean }>('/photos', { method: 'POST', body: form });
}
```

et ajouter à la fin du fichier :

```ts
export interface CaveRow {
  id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null;
  color: WineColor; formatCl: number; referencePhotoId: string | null; quantity: number;
}
export function getCave(filter: { q?: string; color?: WineColor; includeEmpty?: boolean }) {
  const q = new URLSearchParams();
  if (filter.q) q.set('q', filter.q);
  if (filter.color) q.set('color', filter.color);
  if (filter.includeEmpty) q.set('includeEmpty', 'true');
  const s = q.toString();
  return apiFetch<CaveRow[]>(`/cave${s ? `?${s}` : ''}`);
}

export interface WineDetail {
  wine: CaveRow;
  movements: Array<{ id: string; delta: number; type: 'IN' | 'OUT' | 'ADJUST'; occurredAt: string; note: string | null; reversesId: string | null }>;
}
export const getWine = (id: string) => apiFetch<WineDetail>(`/wines/${id}`);

export const createOut = (input: { idempotencyKey: string; wineId: string; quantity: number; photoId?: string | null }) =>
  apiFetch<MovementResult>('/movements/out', { method: 'POST', body: JSON.stringify(input) });

export interface InventoryResult { movement: { id: string } | null; stock: number; delta: number; created: boolean }
export const postInventory = (wineId: string, input: { idempotencyKey: string; counted: number }) =>
  apiFetch<InventoryResult>(`/wines/${wineId}/inventory`, { method: 'POST', body: JSON.stringify(input) });

export interface ExitRead { producer: string | null; cuvee: string | null; appellation: string | null; vintage: number | null }
export interface ExitCandidate { wine: Omit<CaveRow, 'quantity' | 'referencePhotoId'>; quantity: number; referencePhotoId: string | null; score: number }
export type ExitCandidatesResponse =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'FAILED'; errorMessage: string | null }
  | { status: 'DONE'; outcome: 'UNIQUE' | 'SEVERAL' | 'NONE'; read: ExitRead; candidates: ExitCandidate[] };
export const getExitCandidates = (photoId: string) => apiFetch<ExitCandidatesResponse>(`/photos/${photoId}/exit-candidates`);
```

- [ ] **Step 4: Vignette**

`web/src/components/WineThumb.tsx` :

```tsx
import { Icon } from './Icon';

/** Photo d'entrée du vin, ou un pictogramme quand le vin a été saisi sans photo. */
export function WineThumb({ photoId, size = 56 }: { photoId: string | null; size?: number }) {
  if (!photoId) {
    return (
      <span className="thumb thumb--empty" style={{ width: size, height: size * 1.25 }} aria-label="Pas de photo" role="img">
        <Icon name="wine_bar" />
      </span>
    );
  }
  return (
    <img className="thumb" src={`/api/photos/${photoId}/image`} alt="" width={size} height={size * 1.25} loading="lazy" decoding="async" />
  );
}
```

Dans `web/src/styles/base.css`, à la fin :

```css
/* Lot 2a — la cave et la sortie. */
.thumb { object-fit: cover; border-radius: var(--radius-md); flex: none; background: var(--color-surface-container-low); }
.thumb--empty { display: inline-flex; align-items: center; justify-content: center; color: var(--color-secondary); border: 1px solid var(--color-outline-subtle); }
.cave-filters { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; }
.cave-filters input[type="search"] { flex: 1 1 100%; font-size: 16px; padding: var(--space-sm) var(--space-md); border: 1px solid var(--color-outline-variant); border-radius: var(--radius-lg); background: var(--color-surface-lowest); }
.cave-row { display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--color-outline-subtle); color: inherit; text-decoration: none; }
.cave-row__qty { margin-left: auto; font: 700 18px var(--font-sans); color: var(--color-primary); }
.candidates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.candidate { display: flex; flex-direction: column; align-items: center; gap: var(--space-xs); padding: var(--space-sm); border: 1px solid var(--color-outline-subtle); border-radius: var(--radius-lg); background: var(--color-surface-lowest); color: inherit; font: inherit; cursor: pointer; }
.candidate__vintage { font: 700 24px var(--font-sans); color: var(--color-primary); }
```

- [ ] **Step 5: Page Cave**

`web/src/pages/CavePage.tsx` :

```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { getCave, WineColor } from '../lib/api-client';

const COLORS: Array<{ value: WineColor | ''; label: string }> = [
  { value: '', label: 'Toutes' }, { value: 'ROUGE', label: 'Rouge' }, { value: 'BLANC', label: 'Blanc' },
  { value: 'ROSE', label: 'Rosé' }, { value: 'PETILLANT', label: 'Pétillant' },
];

export function CavePage() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [color, setColor] = useState<WineColor | ''>('');
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const filter = { q, color: color || undefined, includeEmpty };
  const cave = useQuery({ queryKey: ['cave', filter], queryFn: () => getCave(filter) });

  return (
    <>
      <TopBar title="La cave" />
      <main className="page">
        <section className="cave-filters">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Domaine, cuvée, appellation…" aria-label="Rechercher" />
          {/* Libellé relié par htmlFor : enveloppé dans le <label>, le select aurait
              pour nom accessible « Couleur » suivi du texte de toutes ses options. */}
          <label htmlFor="cave-color" className="field__label">Couleur</label>
          <select id="cave-color" value={color} onChange={(e) => setColor(e.target.value as WineColor | '')}>
            {COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <label className="field__label">
            <input type="checkbox" checked={includeEmpty} onChange={(e) => setIncludeEmpty(e.target.checked)} aria-label="Afficher les vins épuisés" />
            Vins épuisés
          </label>
        </section>
        {cave.isError && <p role="alert" className="text-error">Impossible de charger la cave.</p>}
        {cave.data?.length === 0 && <p className="centered">Aucun vin ne correspond.</p>}
        <div className="list">
          {cave.data?.map((w) => (
            <Link key={w.id} to={`/cave/${w.id}`} className="cave-row" style={{ opacity: w.quantity > 0 ? 1 : 0.55 }}>
              <WineThumb photoId={w.referencePhotoId} size={44} />
              <span style={{ minWidth: 0 }}>
                <span className="list__title" style={{ display: 'block' }}>
                  {w.producer}{w.cuvee ? ` — ${w.cuvee}` : ''} {w.vintage ?? 'NV'}
                </span>
                <span className="list__meta">{w.appellationRaw}</span>
              </span>
              <span className="cave-row__qty num">{w.quantity}</span>
            </Link>
          ))}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
```

Le champ de recherche a le rôle `searchbox` grâce à `type="search"` (assertion du test).

- [ ] **Step 6: Routes et navigation**

Dans `web/src/router.tsx`, importer `CavePage` et ajouter après la route `/journal` :

```tsx
          { path: '/cave', element: <CavePage /> },
```

Dans `web/src/components/BottomNav.tsx`, passer l'onglet Cave à `soon: false` :

```ts
  { to: '/cave', icon: 'shelves', label: 'Cave', soon: false },
```

- [ ] **Step 7: Lancer les tests**

Run: `cd web && npx vitest run && npm run lint && npx tsc --noEmit`
Expected: PASS (les tests existants restent verts).

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(cave): onglet Cave avec recherche, filtre et vignettes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — fiche vin, sortie par la liste, inventaire

**Files:**
- Create: `web/src/components/SortieConfirmation.tsx`, `web/src/components/SortieConfirmation.test.tsx`
- Create: `web/src/pages/WinePage.tsx`, `web/src/pages/WinePage.test.tsx`
- Modify: `web/src/router.tsx`

**Interfaces:**
- Consumes: `getWine`, `createOut`, `postInventory`, `cancelMovement`, `CaveRow`, `WineThumb` (tâche 6).
- Produces: `SortieConfirmation({ wine, photoId, onDone }: { wine: CaveRow; photoId?: string | null; onDone?: () => void })` — sélecteur de quantité borné au stock, bouton *Sortir*, résultat « Sorti — il en reste N », lien *Annuler* ; utilisé par la tâche 8.

- [ ] **Step 1: Tests du panneau de confirmation**

`web/src/components/SortieConfirmation.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieConfirmation } from './SortieConfirmation';

afterEach(() => vi.restoreAllMocks());

const wine: api.CaveRow = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019,
  color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 3,
};
const result = (stock: number): api.MovementResult => ({
  movement: { id: 'm1', delta: -1, type: 'OUT', occurredAt: '' }, wine: { ...wine, cuvee: wine.cuvee }, stock, created: true,
});

function mount(props: Partial<Parameters<typeof SortieConfirmation>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SortieConfirmation wine={wine} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('sort une bouteille par défaut et annonce le stock restant', async () => {
  const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
  mount({ photoId: 'px' });
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  await waitFor(() => expect(out).toHaveBeenCalledTimes(1));
  expect(out.mock.calls[0][0]).toMatchObject({ wineId: 'w1', quantity: 1, photoId: 'px' });
  expect(out.mock.calls[0][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('Sorti — il en reste 2')).toBeInTheDocument();
});

it('borne la quantité au stock', async () => {
  mount();
  const more = screen.getByRole('button', { name: 'Une bouteille de plus' });
  await userEvent.click(more);
  await userEvent.click(more);
  await userEvent.click(more);
  expect(screen.getByRole('button', { name: /Sortir 3 bouteilles/ })).toBeInTheDocument();
  expect(more).toBeDisabled();
});

it('envoie une seule sortie sur un double tap', async () => {
  const out = vi.spyOn(api, 'createOut').mockImplementation(() => new Promise((r) => setTimeout(() => r(result(2)), 20)));
  mount();
  const button = screen.getByRole('button', { name: /Sortir 1 bouteille/ });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText('Sorti — il en reste 2');
  expect(out).toHaveBeenCalledTimes(1);
});

it('affiche en clair un stock devenu insuffisant, sans rien sortir', async () => {
  vi.spyOn(api, 'createOut').mockRejectedValue(new api.ApiError(409, 'Il n’en reste que 0'));
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Il n’en reste que 0');
  expect(screen.queryByText(/Sorti —/)).not.toBeInTheDocument();
});

it('annule la sortie depuis le message de résultat', async () => {
  vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
  const cancel = vi.spyOn(api, 'cancelMovement').mockResolvedValue(result(3));
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Annuler la sortie' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('m1', expect.stringMatching(/^[0-9a-f-]{36}$/)));
  expect(await screen.findByText('Sortie annulée — 3 en stock')).toBeInTheDocument();
});
```

- [ ] **Step 2: Tests de la fiche vin**

`web/src/pages/WinePage.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { WinePage } from './WinePage';

afterEach(() => vi.restoreAllMocks());

const detail: api.WineDetail = {
  wine: { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 6 },
  movements: [{ id: 'm1', delta: 6, type: 'IN', occurredAt: '2026-09-21T10:00:00Z', note: null, reversesId: null }],
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cave/w1']}>
        <Routes>
          <Route path="/cave/:wineId" element={<WinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('affiche le vin, son stock et ses derniers mouvements', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
  expect(screen.getByText('6 en stock')).toBeInTheDocument();
  expect(screen.getByText('+6')).toBeInTheDocument();
});

it('annonce l’écart avant de corriger le stock', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory').mockResolvedValue({ movement: { id: 'a1' }, stock: 4, delta: -2, created: true });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '4');
  expect(screen.getByText('−2 bouteilles')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
  await waitFor(() => expect(inventory).toHaveBeenCalledWith('w1', { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), counted: 4 }));
});

it('dit « stock déjà juste » et n’envoie rien quand le compte est identique', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory');
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  expect(screen.getByText('Stock déjà juste')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
  expect(inventory).not.toHaveBeenCalled();
});

it('refuse un compte négatif ou décimal', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '2.5');
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
});

it('montre « Vin introuvable » pour un identifiant inconnu', async () => {
  vi.spyOn(api, 'getWine').mockRejectedValue(new api.ApiError(404, 'Vin introuvable'));
  mount();
  expect(await screen.findByText('Vin introuvable')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Retour à la cave' })).toHaveAttribute('href', '/cave');
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

Run: `cd web && npx vitest run src/components/SortieConfirmation.test.tsx src/pages/WinePage.test.tsx`
Expected: FAIL — modules introuvables.

- [ ] **Step 4: Panneau de confirmation**

`web/src/components/SortieConfirmation.tsx` :

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { cancelMovement, CaveRow, createOut, MovementResult } from '../lib/api-client';
import { Button } from './Button';
import { Icon } from './Icon';
import { WineThumb } from './WineThumb';

/**
 * Seul endroit où une sortie s'écrit, depuis la fiche vin comme depuis la photo.
 * Une clé d'idempotence par affichage, un verrou contre le double tap : une
 * confirmation ne débite qu'une fois.
 */
export function SortieConfirmation({ wine, photoId, onDone }: { wine: CaveRow; photoId?: string | null; onDone?: () => void }) {
  const qc = useQueryClient();
  const [quantity, setQuantity] = useState(1);
  const [result, setResult] = useState<MovementResult | null>(null);
  const [cancelled, setCancelled] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  // Une clé par vin affiché : un nouveau vin doit recevoir une nouvelle clé.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [wine.id]);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'movements'].includes(String(q.queryKey[0])) });

  async function sortir() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      setResult(await createOut({ idempotencyKey, wineId: wine.id, quantity, photoId: photoId ?? null }));
      void refresh();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sortie impossible');
      sending.current = false;
    } finally {
      setBusy(false);
    }
  }

  async function annuler() {
    if (!result) return;
    setBusy(true);
    try {
      const r = await cancelMovement(result.movement.id, crypto.randomUUID());
      setCancelled(r.stock);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Annulation impossible');
    } finally {
      setBusy(false);
    }
  }

  if (cancelled !== null) return <p role="status" className="card">Sortie annulée — {cancelled} en stock</p>;
  if (result) {
    return (
      <section className="card" role="status">
        <p style={{ margin: 0, fontWeight: 600 }}>Sorti — il en reste {result.stock}</p>
        <Button variant="link" onClick={annuler} disabled={busy} aria-label="Annuler la sortie">Annuler</Button>
        {error && <p role="alert" className="text-error">{error}</p>}
      </section>
    );
  }

  const max = wine.quantity;
  return (
    <section className="card">
      <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
        <WineThumb photoId={wine.referencePhotoId} size={64} />
        <div>
          <p className="list__title" style={{ margin: 0 }}>{wine.producer}{wine.cuvee ? ` — ${wine.cuvee}` : ''}</p>
          <p className="list__meta" style={{ margin: 0 }}>{wine.appellationRaw} · {wine.vintage ?? 'NV'} · {max} en stock</p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-md)', margin: 'var(--space-md) 0' }}>
        <Button variant="outline" onClick={() => setQuantity((n) => Math.max(1, n - 1))} disabled={quantity <= 1} aria-label="Une bouteille de moins">
          <Icon name="remove" />
        </Button>
        <span className="num" style={{ fontSize: 28 }}>{quantity}</span>
        <Button variant="outline" onClick={() => setQuantity((n) => Math.min(max, n + 1))} disabled={quantity >= max} aria-label="Une bouteille de plus">
          <Icon name="add" />
        </Button>
      </div>
      {error && <p role="alert" className="text-error">{error}</p>}
      <Button variant="dark" onClick={sortir} disabled={busy || max < 1}>
        <Icon name="remove_circle_outline" />
        {busy ? 'Sortie…' : `Sortir ${quantity} bouteille${quantity > 1 ? 's' : ''}`}
      </Button>
    </section>
  );
}
```

- [ ] **Step 5: Fiche vin**

`web/src/pages/WinePage.tsx` :

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { SortieConfirmation } from '../components/SortieConfirmation';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { ApiError, getWine, postInventory } from '../lib/api-client';

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const TYPE_LABEL = { IN: 'Entrée', OUT: 'Sortie', ADJUST: 'Correction' } as const;

function plural(n: number) {
  return `${n} bouteille${Math.abs(n) > 1 ? 's' : ''}`;
}

export function WinePage() {
  const { wineId = '' } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['wine', wineId], queryFn: () => getWine(wineId) });
  const [counting, setCounting] = useState(false);
  const [counted, setCounted] = useState('');
  const [inventoryMessage, setInventoryMessage] = useState<string | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inventoryKey = useMemo(() => crypto.randomUUID(), [wineId, counting]);

  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <>
        <TopBar title="Fiche vin" back="/cave" />
        <main className="page">
          <p className="centered">{notFound ? 'Vin introuvable' : 'Impossible de charger la fiche.'}</p>
          <Link to="/cave" className="btn btn--outline">Retour à la cave</Link>
        </main>
      </>
    );
  }
  if (!detail.data) return <TopBar title="Fiche vin" back="/cave" />;

  const { wine, movements } = detail.data;
  const parsed = /^\d+$/.test(counted) ? Number(counted) : null;
  const delta = parsed === null ? null : parsed - wine.quantity;

  async function saveInventory() {
    if (parsed === null || delta === 0) return;
    setSaving(true);
    setInventoryError(null);
    try {
      const r = await postInventory(wine.id, { idempotencyKey: inventoryKey, counted: parsed });
      setInventoryMessage(`Stock corrigé : ${r.stock} en stock`);
      setCounting(false);
      void qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'movements'].includes(String(q.queryKey[0])) });
    } catch (e) {
      setInventoryError(e instanceof Error ? e.message : 'Correction impossible');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Fiche vin" back="/cave" />
      <main className="page">
        <section className="card" style={{ display: 'flex', gap: 'var(--space-md)' }}>
          <WineThumb photoId={wine.referencePhotoId} size={96} />
          <div>
            <h2 className="list__title" style={{ fontSize: 20, margin: 0 }}>
              {wine.producer}{wine.cuvee ? ` — ${wine.cuvee}` : ''}
            </h2>
            <p className="list__meta">{wine.appellationRaw} · {wine.vintage ?? 'NV'} · {wine.formatCl} cl</p>
            <p className="num" style={{ fontSize: 22, margin: 0 }}>{wine.quantity} en stock</p>
          </div>
        </section>

        {wine.quantity > 0 && <SortieConfirmation key={`${wine.id}-${wine.quantity}`} wine={wine} />}

        <section className="card">
          {inventoryMessage && <p role="status">{inventoryMessage}</p>}
          {!counting ? (
            <Button variant="outline" onClick={() => { setCounting(true); setCounted(String(wine.quantity)); setInventoryMessage(null); }}>
              Corriger le stock
            </Button>
          ) : (
            <>
              <label className="field__label">
                Bouteilles comptées
                <input inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value.trim())} />
              </label>
              <p>{delta === null ? 'Saisis un nombre entier' : delta === 0 ? 'Stock déjà juste' : `${delta > 0 ? '+' : '−'}${plural(Math.abs(delta))}`}</p>
              {inventoryError && <p role="alert" className="text-error">{inventoryError}</p>}
              <Button variant="dark" onClick={saveInventory} disabled={saving || delta === null || delta === 0}>Enregistrer l’inventaire</Button>
              <Button variant="link" onClick={() => setCounting(false)}>Abandonner</Button>
            </>
          )}
        </section>

        <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>DERNIERS MOUVEMENTS</h2>
        <div className="list">
          {movements.map((m) => (
            <div key={m.id} className="list__row">
              <span className={`list__delta ${m.delta > 0 ? 'list__delta--in' : 'list__delta--out'} num`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
              <span className="list__meta">{TYPE_LABEL[m.type]} · {fmt.format(new Date(m.occurredAt))}{m.note ? ` · ${m.note}` : ''}</span>
            </div>
          ))}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
```

Dans `web/src/router.tsx`, importer `WinePage` et ajouter après `/cave` :

```tsx
          { path: '/cave/:wineId', element: <WinePage /> },
```

- [ ] **Step 6: Lancer les tests**

Run: `cd web && npx vitest run && npm run lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "feat(cave): fiche vin, sortie par la liste et inventaire physique

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — sortie par photo

**Files:**
- Create: `web/src/pages/SortieCapturePage.tsx`, `web/src/pages/SortieCapturePage.test.tsx`
- Create: `web/src/pages/SortieResolutionPage.tsx`, `web/src/pages/SortieResolutionPage.test.tsx`
- Modify: `web/src/router.tsx`, `web/src/components/BottomNav.tsx`, `web/src/pages/HomePage.tsx`, `web/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: `uploadPhoto(file, 'EXIT')`, `getExitCandidates`, `ExitCandidatesResponse`, `CaveRow` (tâche 6) ; `SortieConfirmation` (tâche 7).
- Produces: routes `/sortie` et `/sortie/:photoId` ; constante `EXIT_FALLBACK_MS = 12_000` exportée par `SortieResolutionPage.tsx`.

- [ ] **Step 1: Tests de la capture**

`web/src/pages/SortieCapturePage.test.tsx` :

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieCapturePage } from './SortieCapturePage';

afterEach(() => vi.restoreAllMocks());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/sortie']}>
      <Routes>
        <Route path="/sortie" element={<SortieCapturePage />} />
        <Route path="/sortie/:photoId" element={<p>Résolution</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('envoie la photo comme photo de sortie puis ouvre la résolution', async () => {
  const upload = vi.spyOn(api, 'uploadPhoto').mockResolvedValue({ id: 'p9', status: 'PENDING', duplicate: false });
  mount();
  await userEvent.upload(screen.getByLabelText('Photographier l’étiquette'), new File(['x'], 'b.jpg', { type: 'image/jpeg' }));
  await waitFor(() => expect(upload).toHaveBeenCalledWith(expect.any(File), 'EXIT'));
  expect(await screen.findByText('Résolution')).toBeInTheDocument();
});

it('propose la recherche dans la cave quand l’envoi échoue', async () => {
  vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new Error('Réseau indisponible'));
  mount();
  await userEvent.upload(screen.getByLabelText('Photographier l’étiquette'), new File(['x'], 'b.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible');
  expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toHaveAttribute('href', '/cave');
});
```

- [ ] **Step 2: Tests de la résolution**

`web/src/pages/SortieResolutionPage.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieResolutionPage } from './SortieResolutionPage';

afterEach(() => vi.restoreAllMocks());

const cand = (id: string, vintage: number | null): api.ExitCandidate => ({
  wine: { id, producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage, color: 'ROUGE', formatCl: 75 },
  quantity: 2, referencePhotoId: `ref-${id}`, score: 0.9,
});
const read: api.ExitRead = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: null };

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/sortie/p1']}>
        <Routes>
          <Route path="/sortie/:photoId" element={<SortieResolutionPage />} />
          <Route path="/cave" element={<p>Cave</p>} />
          <Route path="/entree" element={<p>Entrée</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('va droit à la confirmation quand le vin est reconnu sans ambiguïté', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'UNIQUE', read, candidates: [cand('w19', 2019)] });
  mount();
  expect(await screen.findByRole('button', { name: /Sortir 1 bouteille/ })).toBeInTheDocument();
  expect(screen.getByText(/2019/)).toBeInTheDocument();
});

it('fait choisir le millésime quand plusieurs vins sont proches, puis confirme', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'SEVERAL', read, candidates: [cand('w19', 2019), cand('w20', 2020)] });
  mount();
  expect(await screen.findByText('Lequel est-ce ?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Sortir 1 bouteille/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /2020/ }));
  expect(await screen.findByRole('button', { name: /Sortir 1 bouteille/ })).toBeInTheDocument();
});

it('propose de chercher (recherche pré-remplie) ou de rentrer le vin quand il n’est pas dans la cave', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'NONE', read, candidates: [] });
  mount();
  expect(await screen.findByText('Ce vin n’est pas dans la cave')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toHaveAttribute('href', '/cave?q=Domaine%20Tempier%20La%20Tourtine');
  expect(screen.getByRole('link', { name: 'Rentrer ce vin' })).toHaveAttribute('href', '/entree');
});

it('bascule tout de suite sur la recherche quand l’analyse échoue', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'FAILED', errorMessage: 'saturé' });
  mount();
  expect(await screen.findByText('Lecture impossible')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toHaveAttribute('href', '/cave');
});

it('propose la recherche au bout de douze secondes sans résultat', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'PROCESSING' });
    mount();
    expect(await screen.findByText(/Lecture de l’étiquette/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Chercher dans la cave' })).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
```

Dans `web/src/pages/HomePage.test.tsx`, remplacer le test existant par :

```tsx
it('propose Rentrer et Sortir', () => {
  vi.spyOn(api, 'getRecentMovements').mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
  expect(screen.getByRole('link', { name: /Sortir une bouteille/ })).toHaveAttribute('href', '/sortie');
  expect(screen.queryByText(/Bientôt/)).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

Run: `cd web && npx vitest run src/pages/SortieCapturePage.test.tsx src/pages/SortieResolutionPage.test.tsx src/pages/HomePage.test.tsx`
Expected: FAIL — modules introuvables ; le bouton Sortir de l'accueil est encore désactivé.

- [ ] **Step 4: Page de capture**

`web/src/pages/SortieCapturePage.tsx` :

```tsx
import { ChangeEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { uploadPhoto } from '../lib/api-client';

export function SortieCapturePage() {
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
      const { id } = await uploadPhoto(file, 'EXIT');
      navigate(`/sortie/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  return (
    <>
      <TopBar title="Sortir une bouteille" back="/" />
      <main className="page capture">
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>Photographiez l’étiquette de la bouteille.</p>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Photographier l’étiquette" />
        <Button variant="dark" onClick={() => input.current?.click()} disabled={busy}>
          <Icon name="photo_camera" />
          {busy ? 'Envoi…' : 'Prendre la photo'}
        </Button>
        {error && (
          <>
            <p role="alert" className="text-error">{error}</p>
            <Link to="/cave" className="btn btn--outline">Chercher dans la cave</Link>
          </>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 5: Page de résolution**

`web/src/pages/SortieResolutionPage.tsx` :

```tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SortieConfirmation } from '../components/SortieConfirmation';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { CaveRow, ExitCandidate, ExitRead, getExitCandidates } from '../lib/api-client';

/**
 * Au-delà, la recherche dans la cave est proposée : l'utilisateur est devant la
 * bouteille, et une photo de sortie n'est jamais reportée à plus tard.
 */
export const EXIT_FALLBACK_MS = 12_000;
const POLL_MS = 1500;

function toRow(c: ExitCandidate): CaveRow {
  return { ...c.wine, quantity: c.quantity, referencePhotoId: c.referencePhotoId };
}

function searchHref(read: ExitRead | null): string {
  const q = [read?.producer, read?.cuvee].filter(Boolean).join(' ');
  return q ? `/cave?q=${encodeURIComponent(q)}` : '/cave';
}

export function SortieResolutionPage() {
  const { photoId = '' } = useParams();
  const [late, setLate] = useState(false);
  const [chosen, setChosen] = useState<ExitCandidate | null>(null);
  const result = useQuery({
    queryKey: ['exit-candidates', photoId],
    queryFn: () => getExitCandidates(photoId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'DONE' || q.state.data.status === 'FAILED') ? false : POLL_MS),
  });

  useEffect(() => {
    setLate(false);
    const timer = setTimeout(() => setLate(true), EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [photoId]);

  const data = result.data;
  const read = data?.status === 'DONE' ? data.read : null;
  const fallback = <Link to={searchHref(read)} className="btn btn--outline">Chercher dans la cave</Link>;

  let body;
  if (result.isError || data?.status === 'FAILED') {
    body = (
      <section className="card" role="alert">
        <p className="text-error" style={{ margin: 0 }}>Lecture impossible</p>
        <p>Retrouvez la bouteille dans la cave : rien n’a été sorti.</p>
        {fallback}
      </section>
    );
  } else if (data?.status === 'DONE' && (chosen || data.outcome === 'UNIQUE')) {
    body = <SortieConfirmation wine={toRow(chosen ?? data.candidates[0])} photoId={photoId} />;
  } else if (data?.status === 'DONE' && data.outcome === 'SEVERAL') {
    body = (
      <section>
        <h2 style={{ fontSize: 18 }}>Lequel est-ce ?</h2>
        <div className="candidates">
          {data.candidates.map((c) => (
            <button key={c.wine.id} type="button" className="candidate" onClick={() => setChosen(c)}>
              <WineThumb photoId={c.referencePhotoId} size={88} />
              <span className="candidate__vintage num">{c.wine.vintage ?? 'NV'}</span>
              <span className="list__meta">{c.wine.producer}{c.wine.cuvee ? ` — ${c.wine.cuvee}` : ''}</span>
            </button>
          ))}
        </div>
        {fallback}
      </section>
    );
  } else if (data?.status === 'DONE') {
    body = (
      <section className="card">
        <p style={{ margin: 0, fontWeight: 600 }}>Ce vin n’est pas dans la cave</p>
        {fallback}
        <Link to="/entree" className="btn btn--primary">Rentrer ce vin</Link>
      </section>
    );
  } else {
    body = (
      <section className="card">
        <p>Lecture de l’étiquette…</p>
        <div className="progress"><span /></div>
        {late && fallback}
      </section>
    );
  }

  return (
    <>
      <TopBar title="Sortir une bouteille" back="/sortie" />
      <main className="page">
        <img className="preview" src={`/api/photos/${photoId}/image`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        {body}
      </main>
    </>
  );
}
```

- [ ] **Step 6: Câblage**

Dans `web/src/router.tsx`, importer les deux pages et ajouter après `/cave/:wineId` :

```tsx
          { path: '/sortie', element: <SortieCapturePage /> },
          { path: '/sortie/:photoId', element: <SortieResolutionPage /> },
```

Dans `web/src/components/BottomNav.tsx` :

```ts
  { to: '/sortie', icon: 'remove_circle_outline', label: 'Sortie', soon: false },
```

Dans `web/src/pages/HomePage.tsx`, remplacer le `<button type="button" className="action action--out" disabled>…</button>` par :

```tsx
          <Link to="/sortie" className="action action--out">
            <Icon name="remove_circle_outline" />
            <span className="action__text">
              <strong>Sortir une bouteille</strong>
              <small>Photo de l’étiquette, ou recherche dans la cave</small>
            </span>
            <Icon name="arrow_forward" />
          </Link>
```

- [ ] **Step 7: Lancer les tests**

Run: `cd web && npx vitest run && npm run lint && npx tsc --noEmit && npm run build`
Expected: PASS et build Vite réussi.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(sortie): sortie par photo avec choix sur vignettes et repli sur la cave

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Vérification dans le navigateur, documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: tout ce qui précède.

- [ ] **Step 1: Suites complètes**

Run: `cd api && npx jest && npm run lint && npm run build && cd ../web && npx vitest run && npm run lint && npm run build`
Expected: tout vert.

- [ ] **Step 2: Essai dans le navigateur, largeur téléphone (375 px)**

Démarrer PostgreSQL et Redis locaux, l'api (`cd api && npm run start:dev`) avec le compte de secours, et le web (configuration `web` de `.claude/launch.json`). Avec une cave d'au moins deux millésimes du même vin (via une entrée manuelle), vérifier : onglet *Cave* (recherche « chateauneuf », filtre couleur, épuisés) ; fiche vin (sortie de 2 bouteilles puis *Annuler*, correction du stock avec l'écart annoncé) ; *Sortir une bouteille* depuis l'accueil. Sans clé Gemini, l'analyse échoue : vérifier que l'écran bascule sur *Chercher dans la cave*. Capturer chaque écran ; aucun texte ne déborde et rien ne chevauche la barre de navigation.

- [ ] **Step 3: README**

Dans `README.md` :
- dans « État » en tête : `lot 0 + lot 1 + lot 2a livrés` et la sortie de stock dans la liste ;
- dans « Fonctionnalités », ajouter après « Mode campagne » un paragraphe **La cave et la sortie** : onglet Cave (recherche sans accents, filtre couleur, épuisés), fiche vin (photo de référence, stock, derniers mouvements), sortie par la liste, sortie par photo (recherche restreinte aux vins en stock, choix sur vignettes quand plusieurs millésimes sont proches, « pas dans la cave » avec recherche pré-remplie ou entrée), repli sur la cave au bout de 12 s ou en cas d'échec, photo de sortie jamais reportée ; inventaire physique (écart annoncé, mouvement `ADJUST` daté) ;
- dans « Garde-fous », ajouter : stock jamais négatif **même sous concurrence** (verrou par vin), une seule sortie par photo ;
- dans « Limites », remplacer la ligne « Sortie de stock par photo, apogée et cote iDealwine : lot 2 » par deux lignes : la reconnaissance ne départage pas seule deux millésimes quand l'année est illisible (choix sur vignettes) ; l'apogée (lot 2b) et la cote iDealwine (lot 2c) restent à venir ;
- dans « Journal des modifications », ajouter `### Non publié` en tête avec un résumé de ce lot.

- [ ] **Step 4: CHANGELOG**

Dans `CHANGELOG.md`, ajouter sous l'introduction une section `## Non publié` avec `### Résumé` (le lot 2a boucle le cycle du stock), `### Fonctionnalités` (une puce par écran ou capacité ci-dessus) et `### Corrections` (le verrou du déclencheur « stock jamais négatif » : deux sorties simultanées de la dernière bouteille passaient toutes les deux).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: lot 2a — la cave et la sortie

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
