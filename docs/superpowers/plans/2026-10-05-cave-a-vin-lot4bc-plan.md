# Lots 4b et 4c — Note de dégustation et accords mets-vins : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une note sur 20 par vin (fiche, liste, export, classement « Les mieux notés ») et des accords mets-vins suggérés par Gemini en tâche de fond, affichés sur la fiche et cherchables depuis l'onglet Cave (« Accompagner un plat »).

**Architecture:** La note vit en trois colonnes de `wine`, lues par la requête existante `CaveService.allWithStock()`. Les accords vivent dans une table `pairing`, remplie par une nouvelle file BullMQ `wine-pairing` traitée par le worker existant (même politique de reprise que les photos, même plafond de dépense) ; un appel texte Gemini rend une liste de plats vérifiée. La recherche par plat filtre en mémoire, comme le reste de la cave.

**Tech Stack:** NestJS 10, Prisma 5 (migrations SQL écrites à la main, `migrate deploy`), PostgreSQL 16, BullMQ, `@google/generative-ai`, Jest ; React 18, TanStack Query 5, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-05-cave-a-vin-lot4bc-notes-accords-design.md`

## Global Constraints

- Tout texte visible et tout message d'erreur **en français**.
- Note : nombre de **0 à 20, par pas de 0,5** ; messages exacts « La note doit être comprise entre 0 et 20 » et « La note se donne par demi-point » ; **une seule note par vin**.
- Accords : **5 à 8 plats demandés**, réponse acceptée de **1 à 8 plats**, chacun non vide et de **60 caractères au plus**, doublons retirés (sans accents ni majuscules) ; réponse invalide → `FAILED`, « Réponse de Gemini inexploitable ».
- File `wine-pairing`, identifiant de travail `pairing-<wineId>`, concurrence 1, même attente croissante et même nombre de tentatives que les photos (`EXTRACTION_ATTEMPTS`, stratégie `EXTRACTION_BACKOFF`).
- Une génération d'accords ne bloque **jamais** une entrée ou une sortie.
- Le plafond `GEMINI_MONTHLY_CAP_CENTS` compte photos **et** accords du mois.
- Pas de nouvelle variable d'environnement ; `docker-compose.yml` inchangé ; aucune nouvelle dépendance npm.
- Commits en français, conventionnels, terminés par exactement une ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests sur la base `cave_test` uniquement : `DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379` (démarrer si besoin : `pg_isready -h localhost || LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@16 start -l /tmp/pg.log` et `redis-cli ping || redis-server --daemonize yes`). Appliquer les migrations sur `cave_test` avec `npx prisma migrate deploy`. Jamais la base `cave`.

## Review Focus

1. Régénérer un vin déjà traité doit vraiment relancer un travail (BullMQ ignore un `add` dont l'identifiant existe encore parmi les travaux terminés) — test `schedulePairing` en Task 5.
2. Une panne de Redis ou de la file pendant une entrée ne doit pas faire échouer l'entrée — test `createIn` en Task 5.
3. Une note saisie avec une virgule (« 16,5 ») doit être acceptée dans le formulaire — test en Task 7.
4. La recherche « Agneau » doit trouver « agneau de sept heures » et « Côte d'agneau » (accents, majuscules) — test en Task 6.
5. Ajouter deux colonnes à l'export décale les colonnes suivantes : les tests existants qui lisent les cellules par numéro doivent suivre — Task 3.

---

### Task 1: Schéma — note sur le vin et table des accords

**Files:**
- Create: `api/prisma/migrations/20261008000000_note_degustation/migration.sql`
- Create: `api/prisma/migrations/20261008000001_accords_mets_vins/migration.sql`
- Modify: `api/prisma/schema.prisma` (modèles `Wine`, `AppUser`, enum `PairingStatus`, modèle `Pairing`)
- Test: `api/src/prisma/rating-pairing.integration.spec.ts`

**Interfaces:**
- Produces: colonnes `wine.rating NUMERIC(3,1)`, `wine.rated_at`, `wine.rated_by` ; table `pairing` ; côté Prisma : `Wine.rating Decimal?`, `Wine.ratedAt`, `Wine.ratedById`, `Wine.ratedBy AppUser?`, `Wine.pairing Pairing?`, `Pairing { id, wineId, status, dishes: string[], model, costCents, errorMessage, generatedAt, updatedAt }`, enum `PairingStatus { PENDING DONE FAILED }`.

- [ ] **Step 1: Write the failing test**

Créer `api/src/prisma/rating-pairing.integration.spec.ts` :

```ts
import { PrismaClient, WineColor } from '@prisma/client';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('note et accords (base réelle)', () => {
  const prisma = new PrismaClient();
  let wineId: string;

  beforeAll(async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `rating-${Date.now()}`, producer: 'Domaine Note', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    wineId = wine.id;
  });

  afterAll(async () => {
    await prisma.wine.deleteMany({ where: { id: wineId } });
    await prisma.$disconnect();
  });

  it('accepte une note par demi-point entre 0 et 20', async () => {
    for (const rating of [0, 16.5, 20]) {
      await prisma.wine.update({ where: { id: wineId }, data: { rating } });
    }
    expect(Number((await prisma.wine.findUniqueOrThrow({ where: { id: wineId } })).rating)).toBe(20);
  });

  it('refuse en base une note hors bornes ou qui n’est pas un demi-point', async () => {
    await expect(prisma.$executeRaw`UPDATE wine SET rating = 20.5 WHERE id = ${wineId}`).rejects.toThrow(/wine_rating_valid/);
    await expect(prisma.$executeRaw`UPDATE wine SET rating = 16.3 WHERE id = ${wineId}`).rejects.toThrow(/wine_rating_valid/);
    await expect(prisma.$executeRaw`UPDATE wine SET rating = -1 WHERE id = ${wineId}`).rejects.toThrow(/wine_rating_valid/);
  });

  it('garde un seul jeu d’accords par vin et le supprime avec le vin', async () => {
    const other = await prisma.wine.create({
      data: { matchKey: `pairing-${Date.now()}`, producer: 'Domaine Accords', appellationRaw: 'Bandol', color: WineColor.ROUGE },
    });
    await prisma.pairing.create({ data: { wineId: other.id } });
    await expect(prisma.pairing.create({ data: { wineId: other.id } })).rejects.toThrow();
    const created = await prisma.pairing.findUniqueOrThrow({ where: { wineId: other.id } });
    expect(created).toMatchObject({ status: 'PENDING', dishes: [] });
    await prisma.wine.delete({ where: { id: other.id } });
    expect(await prisma.pairing.findUnique({ where: { wineId: other.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test npx jest src/prisma/rating-pairing.integration.spec.ts`
Expected: FAIL (erreur de type : `rating` / `pairing` inconnus).

- [ ] **Step 3: Write the migrations and the schema**

`api/prisma/migrations/20261008000000_note_degustation/migration.sql` :

```sql
-- Lot 4b : une note de dégustation sur 20 par vin, par demi-point.
-- Les trois colonnes sont vides ensemble (vin non noté) ou renseignées ensemble.
ALTER TABLE wine
  ADD COLUMN rating NUMERIC(3,1),
  ADD COLUMN rated_at TIMESTAMP(3),
  ADD COLUMN rated_by TEXT REFERENCES app_user(id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE wine ADD CONSTRAINT wine_rating_valid
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= 20 AND rating * 2 = TRUNC(rating * 2)));
```

`api/prisma/migrations/20261008000001_accords_mets_vins/migration.sql` :

```sql
-- Lot 4c : accords mets-vins suggérés par Gemini, un jeu par vin, générés en
-- tâche de fond. Seul le résultat est stocké ; il disparaît avec le vin.
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

CREATE TABLE pairing (
  id TEXT PRIMARY KEY,
  wine_id TEXT NOT NULL UNIQUE REFERENCES wine(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status "PairingStatus" NOT NULL DEFAULT 'PENDING',
  dishes TEXT[] NOT NULL DEFAULT '{}',
  model TEXT,
  cost_cents INTEGER,
  error_message TEXT,
  generated_at TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Dans `api/prisma/schema.prisma` :
- ajouter, après l'enum `AccountStatus` :

```prisma
enum PairingStatus {
  PENDING
  DONE
  FAILED
}
```

- dans `model Wine`, après `createdAt`, ajouter :

```prisma
  rating           Decimal?     @db.Decimal(3, 1)
  ratedAt          DateTime?    @map("rated_at")
  ratedById        String?      @map("rated_by")
  ratedBy          AppUser?     @relation(fields: [ratedById], references: [id], onDelete: SetNull)
  pairing          Pairing?
```

- dans `model AppUser`, après `createdAt`, ajouter `ratedWines   Wine[]` ;
- ajouter le modèle :

```prisma
model Pairing {
  id           String        @id @default(uuid())
  wineId       String        @unique @map("wine_id")
  wine         Wine          @relation(fields: [wineId], references: [id], onDelete: Cascade)
  status       PairingStatus @default(PENDING)
  dishes       String[]      @default([])
  model        String?
  costCents    Int?          @map("cost_cents")
  errorMessage String?       @map("error_message")
  generatedAt  DateTime?     @map("generated_at")
  updatedAt    DateTime      @updatedAt @map("updated_at")

  @@map("pairing")
}
```

Puis : `cd api && npx prisma generate && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test npx prisma migrate deploy`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx tsc --noEmit && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest`
Expected: toute la suite passe.

- [ ] **Step 5: Commit**

```bash
git add api/prisma api/src/prisma/rating-pairing.integration.spec.ts
git commit -m "feat(cave): schéma de la note de dégustation et des accords mets-vins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Note de dégustation — API

**Files:**
- Create: `api/src/cave/rating.dto.ts`
- Modify: `api/src/cave/cave.service.ts` (requête `allWithStock`, `CaveDbRow`, `CaveItem`, `toItem`, `setRating`, `clearRating`)
- Modify: `api/src/cave/cave.controller.ts` (`PUT`/`DELETE wines/:id/rating`)
- Test: `api/src/cave/rating.dto.spec.ts`, `api/src/cave/cave.service.spec.ts`, `api/src/app.e2e.spec.ts`

**Interfaces:**
- Consumes: colonnes de la Task 1.
- Produces :
  - `export interface Rating { value: number; ratedAt: Date; ratedBy: string | null }` (cave.service.ts)
  - `CaveItem = CaveRow & { apogee: Apogee; rating: Rating | null; matchedDish?: string }`
  - `CaveDbRow` gagne les champs facultatifs `rating?: number | null; ratedAt?: Date | null; ratedBy?: string | null; pairingStatus?: string | null; pairingDishes?: string[] | null; pairingError?: string | null; pairingGeneratedAt?: Date | null` (les champs `pairing*` servent aux Tasks 5 et 6)
  - `CaveService.setRating(id: string, value: number, userId: string): Promise<Rating | null>` et `clearRating(id: string): Promise<null>`
  - `export const ratingSchema` (rating.dto.ts)

- [ ] **Step 1: Write the failing tests**

`api/src/cave/rating.dto.spec.ts` :

```ts
import { ratingSchema } from './rating.dto';

const messages = (input: unknown) => {
  const r = ratingSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('ratingSchema', () => {
  it('accepte 0, 16,5 et 20', () => {
    for (const rating of [0, 16.5, 20]) expect(ratingSchema.parse({ rating })).toEqual({ rating });
  });

  it('refuse hors bornes, en français', () => {
    expect(messages({ rating: -1 })).toEqual(['La note doit être comprise entre 0 et 20']);
    expect(messages({ rating: 20.5 })).toEqual(['La note doit être comprise entre 0 et 20']);
    expect(messages({})).toEqual(['La note doit être comprise entre 0 et 20']);
    expect(messages({ rating: 'seize' })).toEqual(['La note doit être comprise entre 0 et 20']);
  });

  it('refuse ce qui n’est pas un demi-point', () => {
    expect(messages({ rating: 16.3 })).toEqual(['La note se donne par demi-point']);
  });
});
```

Dans `api/src/cave/cave.service.spec.ts`, ajouter à la fin :

```ts
describe('CaveService — note de dégustation', () => {
  it('expose la note avec son auteur, et null pour un vin non noté', async () => {
    const rated = { ...cdp, id: 'r1', rating: 16.5, ratedAt: new Date('2026-10-05T10:00:00Z'), ratedBy: 'Franck' };
    const items = await service(null, [rated, { ...cdp, id: 'r2' }]).list({});
    expect(items.find((i) => i.id === 'r1')!.rating).toEqual({ value: 16.5, ratedAt: new Date('2026-10-05T10:00:00Z'), ratedBy: 'Franck' });
    expect(items.find((i) => i.id === 'r2')!.rating).toBeNull();
    expect(items[0]).not.toHaveProperty('ratedAt');
    expect(items[0]).not.toHaveProperty('pairingDishes');
  });

  it('enregistre la note avec la date et l’auteur', async () => {
    const s = service(null, [cdp]);
    await s.setRating('w16', 16.5, 'u1');
    expect((s as any).prisma.wine.update).toHaveBeenCalledWith({
      where: { id: 'w16' }, data: { rating: 16.5, ratedAt: expect.any(Date), ratedById: 'u1' },
    });
  });

  it('retire la note', async () => {
    const s = service(null, [cdp]);
    expect(await s.clearRating('w16')).toBeNull();
    expect((s as any).prisma.wine.update).toHaveBeenCalledWith({ where: { id: 'w16' }, data: { rating: null, ratedAt: null, ratedById: null } });
  });

  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, [cdp]).setRating('nope', 12, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Dans `api/src/app.e2e.spec.ts`, juste avant `it('refuses the admin listing without a session'`, ajouter :

```ts
  it('lets a signed-in account rate a wine, then remove the rating', async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-rating-${Date.now()}`, producer: 'Domaine e2e note', appellationRaw: 'Bandol', color: 'ROUGE' },
    });
    try {
      const ok = await agent.put(`/api/wines/${wine.id}/rating`).send({ rating: 16.5 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ value: 16.5, ratedBy: expect.any(String) });
      const detail = await agent.get(`/api/wines/${wine.id}`);
      expect(detail.body.wine.rating.value).toBe(16.5);
      const bad = await agent.put(`/api/wines/${wine.id}/rating`).send({ rating: 16.3 });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe('La note se donne par demi-point');
      const cleared = await agent.delete(`/api/wines/${wine.id}/rating`);
      expect(cleared.status).toBe(200);
      expect((await agent.get(`/api/wines/${wine.id}`)).body.wine.rating).toBeNull();
      expect((await supertest(app.getHttpServer()).put(`/api/wines/${wine.id}/rating`).send({ rating: 12 })).status).toBe(401);
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/cave`
Expected: FAIL (`./rating.dto` introuvable, `setRating` inexistant).

- [ ] **Step 3: Write the implementation**

`api/src/cave/rating.dto.ts` :

```ts
import { z } from 'zod';

const RANGE = 'La note doit être comprise entre 0 et 20';

/** Note de dégustation : de 0 à 20, par demi-point. */
export const ratingSchema = z.object({
  rating: z
    .number({ required_error: RANGE, invalid_type_error: RANGE })
    .min(0, RANGE)
    .max(20, RANGE)
    .refine((v) => Number.isInteger(v * 2), 'La note se donne par demi-point'),
});

export type RatingInput = z.infer<typeof ratingSchema>;
```

Dans `api/src/cave/cave.service.ts` :

1. Remplacer la déclaration de `CaveDbRow` et `CaveItem` par :

```ts
/** Colonnes de note et d'accords lues avec chaque vin ; facultatives pour les lignes construites à la main. */
interface RatingColumns { rating?: number | null; ratedAt?: Date | null; ratedBy?: string | null }
interface PairingColumns {
  pairingStatus?: string | null;
  pairingDishes?: string[] | null;
  pairingError?: string | null;
  pairingGeneratedAt?: Date | null;
}

/** Ligne lue en base : la ligne publique plus ce qu'il faut pour estimer l'apogée, la note et les accords. */
export type CaveDbRow = CaveRow & Omit<ApogeeWineInput, 'vintage' | 'color'> & RatingColumns & PairingColumns;

export interface Rating { value: number; ratedAt: Date; ratedBy: string | null }

export type CaveItem = CaveRow & { apogee: Apogee; rating: Rating | null; matchedDish?: string };

export function ratingOf(row: CaveDbRow): Rating | null {
  return row.rating == null || row.ratedAt == null ? null : { value: Number(row.rating), ratedAt: row.ratedAt, ratedBy: row.ratedBy ?? null };
}
```

2. Remplacer `toItem` par :

```ts
function toItem(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): CaveItem {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars -- champs internes retirés de la réponse */
    appellationId, region, referenceGuardMin, referenceGuardMax, apogeeMin, apogeeMax, apogeeSource,
    rating, ratedAt, ratedBy, pairingStatus, pairingDishes, pairingError, pairingGeneratedAt,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...pub
  } = row;
  return { ...pub, apogee: apogeeOf(row, rules, currentYear), rating: ratingOf(row) };
}
```

(Si le lint préfère une autre forme de désactivation, garder celle qui passe `npx eslint src/cave --quiet` sans désactiver la règle pour tout le fichier.)

3. Dans `allWithStock()`, ajouter au `SELECT` (après `w.apogee_source AS "apogeeSource"`) :

```sql
             , w.rating::FLOAT8 AS rating, w.rated_at AS "ratedAt", COALESCE(u.display_name, u.email) AS "ratedBy",
             p.status::TEXT AS "pairingStatus", p.dishes AS "pairingDishes", p.error_message AS "pairingError",
             p.generated_at AS "pairingGeneratedAt"
```

et aux jointures (après `LEFT JOIN appellation a …`) :

```sql
      LEFT JOIN app_user u ON u.id = w.rated_by
      LEFT JOIN pairing p ON p.wine_id = w.id
```

4. Ajouter à la classe, à côté de `setManualApogee` :

```ts
  async setRating(id: string, value: number, userId: string): Promise<Rating | null> {
    await this.updateWine(id, { rating: value, ratedAt: new Date(), ratedById: userId });
    return (await this.detail(id)).wine.rating;
  }

  async clearRating(id: string): Promise<null> {
    await this.updateWine(id, { rating: null, ratedAt: null, ratedById: null });
    return null;
  }
```

et renommer la méthode privée `updateApogee` en `updateWine(id, data: Prisma.WineUncheckedUpdateInput)` (mêmes corps et gestion du `P2025` → `NotFoundException('Vin introuvable')`), en mettant à jour ses deux appelants.

Dans `api/src/cave/cave.controller.ts`, importer `ratingSchema`, `AppUser` (`@prisma/client`) et `CurrentUser` (`../auth/current-user.decorator`), et ajouter :

```ts
  @Put('wines/:id/rating')
  setRating(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AppUser) {
    const parsed = ratingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.cave.setRating(id, parsed.data.rating, user.id);
  }

  @Delete('wines/:id/rating')
  clearRating(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.clearRating(id);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx tsc --noEmit && npx eslint src --quiet && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest`
Expected: toute la suite passe (le service `StatsService` et l'export lisent `allWithStock()` ou Prisma et ne changent pas de comportement).

- [ ] **Step 5: Commit**

```bash
git add api/src/cave api/src/app.e2e.spec.ts
git commit -m "feat(cave): note de dégustation sur 20, posée et retirée par tout compte actif

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: « Les mieux notés » et colonnes d'export

**Files:**
- Modify: `api/src/stats/stats.ts` (`StatsWine.rating`, `Stats.bestRated`), `api/src/stats/stats.service.ts`
- Modify: `api/src/export/export.service.ts` (colonnes *Note /20* et *Accords*)
- Test: `api/src/stats/stats.spec.ts`, `api/src/stats/stats.service.spec.ts`, `api/src/export/export.service.spec.ts`

**Interfaces:**
- Consumes: `CaveDbRow.rating` (Task 2) ; `Wine.rating`, `Wine.pairing` (Task 1).
- Produces: `StatsWine.rating: number | null` ; `Stats.bestRated: RankedWine[]` (`value` = note).

- [ ] **Step 1: Write the failing tests**

Dans `api/src/stats/stats.spec.ts` : ajouter `rating: null` à l'objet par défaut de la fabrique `wine(...)`, puis ajouter dans `describe('computeStats — classements', …)` :

```ts
  it('les mieux notés, en stock ou non, départagés par producteur, limités à 5', () => {
    const wines = [
      wine('a', { producer: 'Domaine A', rating: 15, quantity: 0 }),
      wine('b', { producer: 'Domaine B', rating: 18.5 }),
      wine('c', { producer: 'Domaine C', rating: 15 }),
      wine('d', { producer: 'Domaine D', rating: null }),
      wine('e', { producer: 'Domaine E', rating: 12 }),
      wine('f', { producer: 'Domaine F', rating: 11 }),
      wine('g', { producer: 'Domaine G', rating: 10 }),
    ];
    expect(computeStats({ wines, movements: [] }, NOW).bestRated.map((w) => [w.id, w.value])).toEqual([
      ['b', 18.5], ['a', 15], ['c', 15], ['e', 12], ['f', 11],
    ]);
  });
```

Dans `api/src/stats/stats.service.spec.ts`, ajouter `rating: 17` à la ligne `row` et vérifier `expect(stats.bestRated).toEqual([{ id: 'w1', producer: 'Château de Beaucastel', cuvee: null, vintage: 2016, value: 17 }]);`.

Dans `api/src/export/export.service.spec.ts` :
- **mettre à jour les numéros de cellule** des tests existants, car deux colonnes s'insèrent : *Note /20* devient la colonne 9 (après *Confiance*, colonne 8), donc *Couleur* passe en 10, *Format (cl)* en 11, *Quantité* en 12, *Prix d'achat unitaire* en 13, *Valeur d'achat* en 14, et *Accords* est la colonne 15 ;
- ajouter :

```ts
  it('ajoute la note et les accords à la feuille Stock', async () => {
    const prisma = fakePrisma();
    const rated = {
      id: 'w5', producer: 'Domaine Noté', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, rating: 16.5,
      appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
      pairing: { status: 'DONE', dishes: ['agneau de sept heures', 'daube provençale'] },
    };
    prisma.wine.findMany = async () => [rated] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w5', quantity: 2 }];
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect([9, 15].map((c) => stock.getRow(1).getCell(c).value)).toEqual(['Note /20', 'Accords']);
    expect([9, 15].map((c) => stock.getRow(2).getCell(c).value)).toEqual([16.5, 'agneau de sept heures ; daube provençale']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/stats src/export`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`api/src/stats/stats.ts` :
- `StatsWine` gagne `rating: number | null;` ;
- `Stats` gagne `bestRated: RankedWine[];` ;
- dans l'objet rendu par `computeStats`, après `mostExpensive` :

```ts
    bestRated: input.wines
      .filter((w) => w.rating != null)
      .map((w) => ranked(w, w.rating as number))
      .sort(valueThenProducer)
      .slice(0, RANKING_SIZE),
```

`api/src/stats/stats.service.ts` : dans le `map` des vins, ajouter `rating: r.rating ?? null,`.

`api/src/export/export.service.ts` :
- `this.prisma.wine.findMany({ include: { appellation: true, pairing: true }, … })` ;
- dans `stock.columns`, après `{ header: 'Confiance', … }` : `{ header: 'Note /20', key: 'rating', width: 9 },` et, en dernière position : `{ header: 'Accords', key: 'pairings', width: 48 },` ;
- dans `stock.addRow({...})`, ajouter `rating: w.rating == null ? null : Number(w.rating),` et `pairings: w.pairing?.status === 'DONE' ? w.pairing.dishes.join(' ; ') : '',` ;
- `stock.autoFilter = { from: 'A1', to: 'O1' };`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx tsc --noEmit && npx eslint src --quiet && npx jest src/stats src/export`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/stats api/src/export
git commit -m "feat(stats): classement des mieux notés, note et accords dans l'export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Suggestions d'accords par Gemini et budget commun

**Files:**
- Create: `api/src/vision/pairing-output.ts`, `api/src/vision/pairing-provider.interface.ts`
- Modify: `api/src/vision/gemini-vision.provider.ts` (méthode `suggestPairings`, calcul du coût mis en commun), `api/src/vision/vision.module.ts` (fournisseur `PAIRING_PROVIDER`)
- Modify: `api/src/queue/vision-budget.service.ts` (somme photos + accords)
- Test: `api/src/vision/pairing-output.spec.ts`, `api/src/vision/gemini-vision.provider.spec.ts`, `api/src/queue/vision-budget.service.spec.ts`

**Interfaces:**
- Produces :
  - `export const PAIRING_PROVIDER = 'PAIRING_PROVIDER'`
  - `export interface PairingWine { producer: string; cuvee: string | null; appellation: string; region: string | null; color: string; vintage: number | null }`
  - `export interface PairingResult { dishes: string[]; model: string; costCents: number }`
  - `export interface PairingProvider { suggestPairings(wine: PairingWine): Promise<PairingResult> }`
  - `export class PairingInvalidOutputError extends Error` (messages commençant par « Sortie du modèle invalide », donc définitifs pour `isTransientVisionFailure`)
  - `export function parsePairingOutput(raw: unknown): string[]`

- [ ] **Step 1: Write the failing tests**

`api/src/vision/pairing-output.spec.ts` :

```ts
import { isTransientVisionFailure } from '../queue/transient-failure';
import { PairingInvalidOutputError, parsePairingOutput } from './pairing-output';

describe('parsePairingOutput', () => {
  it('rend les plats rognés, sans doublons (accents et majuscules ignorés)', () => {
    expect(parsePairingOutput({ plats: [' Agneau de sept heures ', 'Daube  provençale', 'agneau de sept HEURES', 'Daube provencale'] }))
      .toEqual(['Agneau de sept heures', 'Daube provençale']);
  });

  it.each([
    ['sans champ plats', { dishes: ['x'] }],
    ['liste vide', { plats: [] }],
    ['plus de 8 plats', { plats: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['plat vide', { plats: ['agneau', '  '] }],
    ['plat trop long', { plats: ['x'.repeat(61)] }],
    ['plat non textuel', { plats: ['agneau', 3] }],
    ['réponse non objet', 'agneau'],
  ])('refuse une réponse inexploitable : %s', (_label, raw) => {
    expect(() => parsePairingOutput(raw)).toThrow(PairingInvalidOutputError);
  });

  it('classe une réponse inexploitable en échec définitif', () => {
    let error: unknown;
    try { parsePairingOutput({ plats: [] }); } catch (e) { error = e; }
    expect(isTransientVisionFailure(error)).toBe(false);
  });
});
```

Dans `api/src/vision/gemini-vision.provider.spec.ts`, ajouter (en suivant la façon dont le fichier fabrique un faux `model.generateContent`) :

```ts
describe('GeminiVisionProvider.suggestPairings', () => {
  const wine = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', region: 'Provence', color: 'ROUGE', vintage: 2019 };
  const fake = (text: string) => ({
    generateContent: jest.fn(async () => ({ response: { text: () => text, usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50 } } })),
  });

  it('demande des plats en français pour ce vin et rend la liste vérifiée avec son coût', async () => {
    const model = fake('{"plats":["Agneau de sept heures","Daube provençale"]}');
    const r = await new GeminiVisionProvider(model as any, 'gemini-test').suggestPairings(wine);
    expect(r).toEqual({ dishes: ['Agneau de sept heures', 'Daube provençale'], model: 'gemini-test', costCents: 1 });
    const prompt = (model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text as string;
    expect(prompt).toContain('Domaine Tempier');
    expect(prompt).toContain('La Tourtine');
    expect(prompt).toContain('Bandol');
    expect(prompt).toContain('2019');
  });

  it('nomme un vin non millésimé comme tel', async () => {
    const model = fake('{"plats":["Comté"]}');
    await new GeminiVisionProvider(model as any, 'gemini-test').suggestPairings({ ...wine, vintage: null });
    expect((model.generateContent.mock.calls[0] as any)[0].contents[0].parts[0].text).toContain('non millésimé');
  });

  it('refuse un JSON illisible', async () => {
    await expect(new GeminiVisionProvider(fake('pas du json') as any, 'm').suggestPairings(wine)).rejects.toThrow(PairingInvalidOutputError);
  });
});
```

(importer `PairingInvalidOutputError` depuis `./pairing-output`.)

Dans `api/src/queue/vision-budget.service.spec.ts`, ajouter un cas : le faux Prisma expose `photo.aggregate` → `{ _sum: { costCents: 30 } }` et `pairing.aggregate` → `{ _sum: { costCents: 12 } }` ; `spentThisMonthCents()` vaut `42`, et `pairing.aggregate` est appelé avec `{ _sum: { costCents: true }, where: { generatedAt: { gte: expect.any(Date) } } }`. Ajouter `pairing.aggregate` (renvoyant `{ _sum: { costCents: null } }`) aux faux Prisma des cas existants.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/vision src/queue/vision-budget.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`api/src/vision/pairing-provider.interface.ts` :

```ts
export const PAIRING_PROVIDER = 'PAIRING_PROVIDER';

export interface PairingWine {
  producer: string;
  cuvee: string | null;
  appellation: string;
  region: string | null;
  color: string;
  vintage: number | null;
}

export interface PairingResult {
  dishes: string[];
  model: string;
  costCents: number;
}

export interface PairingProvider {
  suggestPairings(wine: PairingWine): Promise<PairingResult>;
}
```

`api/src/vision/pairing-output.ts` :

```ts
import { normalizeLabel } from '../appellations/appellations.service';

export const MAX_DISHES = 8;
export const MAX_DISH_LENGTH = 60;

/**
 * Réponse de Gemini inexploitable. Le message commence par « Sortie du modèle
 * invalide » : `isTransientVisionFailure` la classe en échec définitif, et la
 * file ne la rejoue pas.
 */
export class PairingInvalidOutputError extends Error {}

const invalid = (why: string) => new PairingInvalidOutputError(`Sortie du modèle invalide : ${why}`);

/** Plats suggérés : 1 à 8 libellés non vides de 60 caractères au plus, sans doublons. */
export function parsePairingOutput(raw: unknown): string[] {
  const plats = raw && typeof raw === 'object' ? (raw as { plats?: unknown }).plats : undefined;
  if (!Array.isArray(plats)) throw invalid('champ « plats » absent');
  const seen = new Set<string>();
  const dishes: string[] = [];
  for (const p of plats) {
    if (typeof p !== 'string') throw invalid('plat non textuel');
    const dish = p.trim().replace(/\s+/g, ' ');
    if (!dish) throw invalid('plat vide');
    if (dish.length > MAX_DISH_LENGTH) throw invalid('plat trop long');
    const key = normalizeLabel(dish);
    if (seen.has(key)) continue;
    seen.add(key);
    dishes.push(dish);
  }
  if (dishes.length === 0 || dishes.length > MAX_DISHES) throw invalid(`${dishes.length} plats`);
  return dishes;
}
```

Dans `api/src/vision/gemini-vision.provider.ts` :
- extraire le calcul du coût en fonction locale, utilisée par `extractWineLabel` :

```ts
function costCentsOf(usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): number {
  return Math.ceil(
    ((usage?.promptTokenCount ?? 0) / 1000) * PRICE_PER_1K_TOKENS_CENTS.input +
      ((usage?.candidatesTokenCount ?? 0) / 1000) * PRICE_PER_1K_TOKENS_CENTS.output,
  );
}

const stripFences = (text: string) => text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

const COLOR_WORD: Record<string, string> = { ROUGE: 'rouge', BLANC: 'blanc', ROSE: 'rosé', PETILLANT: 'pétillant' };

function pairingPrompt(w: PairingWine): string {
  return `Tu es sommelier. Propose de 5 à 8 plats qui s'accordent avec ce vin.
Réponds UNIQUEMENT par un objet JSON strict de la forme {"plats": string[]}.
Chaque plat : un nom court en français (60 caractères au plus), sans phrase ni explication.
Vin : producteur « ${w.producer} » ; cuvée « ${w.cuvee ?? 'aucune'} » ; appellation « ${w.appellation} » ; région « ${w.region ?? 'inconnue'} » ; couleur ${COLOR_WORD[w.color] ?? w.color} ; ${w.vintage == null ? 'non millésimé' : `millésime ${w.vintage}`}.`;
}
```

- la classe implémente aussi `PairingProvider` et gagne :

```ts
  async suggestPairings(wine: PairingWine): Promise<PairingResult> {
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: pairingPrompt(wine) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    });
    let raw: unknown;
    try {
      raw = JSON.parse(stripFences(result.response.text()));
    } catch {
      throw new PairingInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
    }
    return { dishes: parsePairingOutput(raw), model: this.modelName, costCents: costCentsOf(result.response.usageMetadata) };
  }
```

Dans `api/src/vision/vision.module.ts` : ajouter le fournisseur `{ provide: PAIRING_PROVIDER, useExisting: VISION_PROVIDER }` et l'exporter.

Dans `api/src/queue/vision-budget.service.ts`, `spentThisMonthCents()` devient :

```ts
  /** Photos et accords du mois : un seul plafond pour toute la dépense Gemini. */
  async spentThisMonthCents(): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const [photos, pairings] = await Promise.all([
      this.prisma.photo.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start } } }),
      this.prisma.pairing.aggregate({ _sum: { costCents: true }, where: { generatedAt: { gte: start } } }),
    ]);
    return (photos._sum.costCents ?? 0) + (pairings._sum.costCents ?? 0);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx tsc --noEmit && npx eslint src --quiet && npx jest src/vision src/queue`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/vision api/src/queue/vision-budget.service.ts api/src/queue/vision-budget.service.spec.ts
git commit -m "feat(accords): suggestions de plats par Gemini, comptées dans le plafond mensuel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: File d'accords, rattrapage, régénération

**Files:**
- Create: `api/src/pairing/pairing.queue.ts`, `api/src/pairing/pairing.processor.ts`, `api/src/pairing/pairing-recovery.ts`, `api/src/pairing/pairing.service.ts`, `api/src/pairing/pairing.controller.ts`, `api/src/pairing/pairing.module.ts`
- Modify: `api/src/movements/movements.service.ts` (mise en file à la création d'un vin), `api/src/movements/movements.module.ts` (import `PairingModule`), `api/src/worker.ts` (second worker + rattrapage), `api/src/app.module.ts` (import `PairingModule`), `api/src/cave/cave.service.ts` (`detail` rend `pairing`)
- Test: `api/src/pairing/pairing.queue.spec.ts`, `api/src/pairing/pairing.processor.spec.ts`, `api/src/pairing/pairing-recovery.spec.ts`, `api/src/movements/movements.service.spec.ts`, `api/src/cave/cave.service.spec.ts`, `api/src/app.e2e.spec.ts`

**Interfaces:**
- Consumes: `PAIRING_PROVIDER`, `PairingProvider` (Task 4) ; `VisionBudgetService` (exporté par `QueueModule`) ; `EXTRACTION_ATTEMPTS`, `EXTRACTION_BACKOFF`, `extractionBackoffDelay`, `redisConnection` (`queue/extraction.queue.ts`) ; `isTransientVisionFailure`, `deferralReason` (`queue/transient-failure.ts`) ; colonnes `pairing*` de `CaveDbRow` (Task 2).
- Produces :
  - `PAIRING_QUEUE = 'wine-pairing'`, `PAIRING_QUEUE_TOKEN = 'PAIRING_QUEUE'`, `interface PairingJobData { wineId: string }`, `pairingJobId(wineId): string` (= `pairing-<wineId>`), `createPairingQueue()`, `closePairingQueue(queue)`, `schedulePairing(queue, wineId): Promise<void>`
  - `PairingScheduler.schedule(wineId: string): Promise<void>` (injectable)
  - `PairingProcessor.process(wineId: string, isLastAttempt?: boolean): Promise<void>`
  - `requeueMissingPairings(prisma, queue, log?): Promise<number>`
  - `POST /api/wines/:id/pairing/regenerate` → `202`
  - `GET /api/wines/:id` : `wine.pairing: { status, dishes, errorMessage, generatedAt } | null`

- [ ] **Step 1: Write the failing tests**

`api/src/pairing/pairing.queue.spec.ts` :

```ts
import { pairingJobId, schedulePairing } from './pairing.queue';

function fakeQueue(existing?: { state: string }) {
  const remove = jest.fn(async () => undefined);
  return {
    remove,
    queue: {
      getJob: jest.fn(async () => (existing ? { getState: async () => existing.state, remove } : undefined)),
      add: jest.fn(async () => undefined),
    },
  };
}

describe('schedulePairing', () => {
  it('met le vin en file sous un identifiant unique', async () => {
    const { queue } = fakeQueue();
    await schedulePairing(queue as any, 'w1');
    expect(queue.add).toHaveBeenCalledWith('pairing', { wineId: 'w1' }, { jobId: pairingJobId('w1') });
    expect(pairingJobId('w1')).toBe('pairing-w1');
  });

  it('ne double pas un travail encore vivant', async () => {
    const { queue } = fakeQueue({ state: 'delayed' });
    await schedulePairing(queue as any, 'w1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'])('relance un travail %s en le retirant d’abord (régénération)', async (state) => {
    const { queue, remove } = fakeQueue({ state });
    await schedulePairing(queue as any, 'w1');
    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
```

`api/src/pairing/pairing.processor.spec.ts` :

```ts
import { UnrecoverableError } from 'bullmq';
import { VisionBudgetExceededError } from '../queue/vision-budget.service';
import { PairingInvalidOutputError } from '../vision/pairing-output';
import { PairingProcessor } from './pairing.processor';

const wine = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE',
  appellation: { canonicalName: 'Bandol', region: 'Provence' },
};

function harness(opts: { wine?: unknown; suggest?: jest.Mock; overCap?: boolean } = {}) {
  const upsert = jest.fn(async () => ({}));
  const update = jest.fn(async () => ({}));
  const prisma = {
    wine: { findUnique: jest.fn(async () => ('wine' in opts ? opts.wine : wine)) },
    pairing: { upsert, update },
  };
  const provider = { suggestPairings: opts.suggest ?? jest.fn(async () => ({ dishes: ['Agneau', 'Daube'], model: 'gemini-test', costCents: 1 })) };
  const budget = { assertUnderCap: jest.fn(async () => { if (opts.overCap) throw new VisionBudgetExceededError(); }) };
  return { upsert, update, provider, processor: new PairingProcessor(prisma as any, provider as any, budget as any) };
}

describe('PairingProcessor', () => {
  it('enregistre les plats suggérés', async () => {
    const h = harness();
    await h.processor.process('w1');
    expect(h.provider.suggestPairings).toHaveBeenCalledWith({
      producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', region: 'Provence', color: 'ROUGE', vintage: 2019,
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { wineId: 'w1' },
      data: { status: 'DONE', dishes: ['Agneau', 'Daube'], model: 'gemini-test', costCents: 1, errorMessage: null, generatedAt: expect.any(Date) },
    });
  });

  it('ignore un vin supprimé entre-temps', async () => {
    const h = harness({ wine: null });
    await h.processor.process('w1');
    expect(h.provider.suggestPairings).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('reporte sur une indisponibilité de Gemini : reste en attente et relance', async () => {
    const h = harness({ suggest: jest.fn(async () => { throw new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] busy'); }) });
    await expect(h.processor.process('w1', false)).rejects.toThrow(/503/);
    expect(h.update).toHaveBeenCalledWith({ where: { wineId: 'w1' }, data: { status: 'PENDING', errorMessage: expect.stringContaining('reprise automatique') } });
  });

  it('attend le mois suivant quand le plafond est atteint', async () => {
    const h = harness({ overCap: true });
    await expect(h.processor.process('w1', false)).rejects.toBeInstanceOf(VisionBudgetExceededError);
    expect(h.provider.suggestPairings).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
  });

  it('échoue définitivement sur une réponse inexploitable', async () => {
    const h = harness({ suggest: jest.fn(async () => { throw new PairingInvalidOutputError('Sortie du modèle invalide : 0 plats'); }) });
    await expect(h.processor.process('w1', false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.update).toHaveBeenCalledWith({ where: { wineId: 'w1' }, data: { status: 'FAILED', errorMessage: 'Réponse de Gemini inexploitable' } });
  });
});
```

`api/src/pairing/pairing-recovery.spec.ts` :

```ts
import { requeueMissingPairings } from './pairing-recovery';

it('met en file les vins sans accords ou en attente, et eux seuls', async () => {
  const findMany = jest.fn(async () => [{ id: 'w1' }, { id: 'w2' }]);
  const queue = { getJob: jest.fn(async () => undefined), add: jest.fn(async () => undefined) };
  const n = await requeueMissingPairings({ wine: { findMany } } as any, queue as any);
  expect(n).toBe(2);
  expect(findMany).toHaveBeenCalledWith({
    where: { OR: [{ pairing: null }, { pairing: { status: 'PENDING' } }] },
    select: { id: true },
  });
  expect(queue.add).toHaveBeenCalledWith('pairing', { wineId: 'w2' }, { jobId: 'pairing-w2' });
});
```

Dans `api/src/movements/movements.service.spec.ts`, ajouter :

```ts
describe('MovementsService — accords à la création d’un vin', () => {
  it('met en file les accords d’un vin créé par l’entrée', async () => {
    const h = harness();
    const schedule = jest.fn(async () => undefined);
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: true, appellation: { kind: 'none', raw: 'Bandol' } }) };
    await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn(input);
    expect(schedule).toHaveBeenCalledWith('w1');
  });

  it('ne fait rien pour un vin déjà connu', async () => {
    const h = harness();
    const schedule = jest.fn(async () => undefined);
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn(input);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('n’échoue jamais à cause de la file d’accords', async () => {
    const h = harness();
    const schedule = jest.fn(async () => { throw new Error('Redis injoignable'); });
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: true, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const r = await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn(input);
    expect(r.created).toBe(true);
  });
});
```

Dans `api/src/cave/cave.service.spec.ts`, ajouter :

```ts
it('rend les accords du vin sur la fiche, et null sans accords', async () => {
  const withPairing = { ...cdp, pairingStatus: 'DONE', pairingDishes: ['Agneau'], pairingError: null, pairingGeneratedAt: new Date('2026-10-05T10:00:00Z') };
  expect((await service(null, [withPairing]).detail('w16')).wine.pairing).toEqual({
    status: 'DONE', dishes: ['Agneau'], errorMessage: null, generatedAt: new Date('2026-10-05T10:00:00Z'),
  });
  expect((await service(null, [cdp]).detail('w16')).wine.pairing).toBeNull();
});
```

Dans `api/src/app.e2e.spec.ts`, juste avant `it('refuses the admin listing without a session'` :

```ts
  it('queues a pairing regeneration for a known wine, 404 otherwise', async () => {
    const wine = await prisma.wine.create({
      data: { matchKey: `e2e-pairing-${Date.now()}`, producer: 'Domaine e2e accords', appellationRaw: 'Bandol', color: 'ROUGE' },
    });
    try {
      const res = await agent.post(`/api/wines/${wine.id}/pairing/regenerate`);
      expect(res.status).toBe(202);
      expect((await prisma.pairing.findUniqueOrThrow({ where: { wineId: wine.id } })).status).toBe('PENDING');
      expect((await agent.get(`/api/wines/${wine.id}`)).body.wine.pairing).toMatchObject({ status: 'PENDING', dishes: [] });
      expect((await agent.post('/api/wines/00000000-0000-4000-8000-000000000000/pairing/regenerate')).status).toBe(404);
      expect((await supertest(app.getHttpServer()).post(`/api/wines/${wine.id}/pairing/regenerate`)).status).toBe(401);
    } finally {
      await prisma.wine.delete({ where: { id: wine.id } });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/pairing src/movements/movements.service.spec.ts src/cave`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Write the implementation**

`api/src/pairing/pairing.queue.ts` :

```ts
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EXTRACTION_ATTEMPTS, EXTRACTION_BACKOFF, redisConnection } from '../queue/extraction.queue';

export const PAIRING_QUEUE = 'wine-pairing';
export const PAIRING_QUEUE_TOKEN = 'PAIRING_QUEUE';

export interface PairingJobData {
  wineId: string;
}

/** Un identifiant par vin : jamais deux générations du même vin dans la file. */
export const pairingJobId = (wineId: string) => `pairing-${wineId}`;

/** Même patience que les photos : une panne de Gemini ne perd jamais un vin. */
export function createPairingQueue(): Queue<PairingJobData> {
  return new Queue<PairingJobData>(PAIRING_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: EXTRACTION_ATTEMPTS, backoff: { type: EXTRACTION_BACKOFF }, removeOnComplete: 1000, removeOnFail: 1000 },
  });
}

export type PairingQueueLike = Pick<Queue<PairingJobData>, 'add' | 'getJob'>;

/**
 * BullMQ ignore un `add` dont l'identifiant existe encore, y compris parmi les
 * travaux terminés gardés en mémoire : pour régénérer, on retire d'abord un
 * travail terminé ou échoué ; un travail encore vivant est laissé tel quel.
 */
export async function schedulePairing(queue: PairingQueueLike, wineId: string): Promise<void> {
  const id = pairingJobId(wineId);
  const job = await queue.getJob(id);
  if (job) {
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed') return;
    await job.remove();
  }
  await queue.add('pairing', { wineId }, { jobId: id });
}

/** Voir `closeQueue` (extraction.queue.ts) : la connexion fournie doit être quittée à la main. */
export async function closePairingQueue(queue: Queue<PairingJobData>): Promise<void> {
  const { connection } = queue.opts;
  await queue.close();
  if (connection instanceof Redis) await connection.quit();
}
```

`api/src/pairing/pairing.processor.ts` :

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { deferralReason, isTransientVisionFailure } from '../queue/transient-failure';
import { VisionBudgetService } from '../queue/vision-budget.service';
import { PAIRING_PROVIDER, PairingProvider } from '../vision/pairing-provider.interface';

@Injectable()
export class PairingProcessor {
  private readonly logger = new Logger(PairingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAIRING_PROVIDER) private readonly provider: PairingProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async process(wineId: string, isLastAttempt = true): Promise<void> {
    const wine = await this.prisma.wine.findUnique({ where: { id: wineId }, include: { appellation: true } });
    if (!wine) return; // vin supprimé depuis la mise en file
    await this.prisma.pairing.upsert({ where: { wineId }, create: { wineId }, update: {} });
    try {
      await this.budget.assertUnderCap();
      const result = await this.provider.suggestPairings({
        producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellation?.canonicalName ?? wine.appellationRaw,
        region: wine.appellation?.region ?? null, color: wine.color, vintage: wine.vintage,
      });
      await this.prisma.pairing.update({
        where: { wineId },
        data: { status: 'DONE', dishes: result.dishes, model: result.model, costCents: result.costCents, errorMessage: null, generatedAt: new Date() },
      });
    } catch (e) {
      const transient = isTransientVisionFailure(e);
      this.logger.warn(`Accords ${wineId} ${transient ? 'reportés' : 'en échec'} : ${e instanceof Error ? e.message : String(e)}`);
      if (transient && !isLastAttempt) {
        await this.prisma.pairing.update({ where: { wineId }, data: { status: 'PENDING', errorMessage: deferralReason(e) } });
        throw e;
      }
      await this.prisma.pairing.update({
        where: { wineId },
        data: { status: 'FAILED', errorMessage: transient ? `${deferralReason(e)} — abandon` : 'Réponse de Gemini inexploitable' },
      });
      throw transient ? e : new UnrecoverableError(e instanceof Error ? e.message : String(e));
    }
  }
}
```

`api/src/pairing/pairing-recovery.ts` :

```ts
import { PairingQueueLike, schedulePairing } from './pairing.queue';

export interface PairingRecoveryPrisma {
  wine: { findMany(args: unknown): Promise<{ id: string }[]> };
}

/**
 * Au démarrage du worker : tout vin sans accords, ou dont la génération est
 * restée en attente, est (re)mis en file. Couvre les vins existants à la mise à
 * jour et les travaux qu'un Redis vidé aurait oubliés. Idempotent.
 */
export async function requeueMissingPairings(
  prisma: PairingRecoveryPrisma,
  queue: PairingQueueLike,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const wines = await prisma.wine.findMany({
    where: { OR: [{ pairing: null }, { pairing: { status: 'PENDING' } }] },
    select: { id: true },
  });
  for (const w of wines) await schedulePairing(queue, w.id);
  if (wines.length) log(`accords : ${wines.length} vin(s) mis en file`);
  return wines.length;
}
```

`api/src/pairing/pairing.service.ts` :

```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PAIRING_QUEUE_TOKEN, PairingJobData, schedulePairing } from './pairing.queue';

@Injectable()
export class PairingScheduler {
  constructor(@Inject(PAIRING_QUEUE_TOKEN) private readonly queue: Queue<PairingJobData>) {}

  schedule(wineId: string): Promise<void> {
    return schedulePairing(this.queue, wineId);
  }
}

@Injectable()
export class PairingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: PairingScheduler,
  ) {}

  async regenerate(wineId: string): Promise<void> {
    const wine = await this.prisma.wine.findUnique({ where: { id: wineId }, select: { id: true } });
    if (!wine) throw new NotFoundException('Vin introuvable');
    await this.prisma.pairing.upsert({
      where: { wineId },
      create: { wineId },
      update: { status: 'PENDING', errorMessage: null },
    });
    await this.scheduler.schedule(wineId);
  }
}
```

`api/src/pairing/pairing.controller.ts` :

```ts
import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { PairingService } from './pairing.service';

@Controller('wines')
@UseGuards(AuthenticatedGuard)
export class PairingController {
  constructor(private readonly pairings: PairingService) {}

  @Post(':id/pairing/regenerate')
  @HttpCode(202)
  regenerate(@Param('id', ParseUUIDPipe) id: string) {
    return this.pairings.regenerate(id);
  }
}
```

`api/src/pairing/pairing.module.ts` :

```ts
import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { PairingController } from './pairing.controller';
import { PairingProcessor } from './pairing.processor';
import { closePairingQueue, createPairingQueue, PAIRING_QUEUE_TOKEN, PairingJobData } from './pairing.queue';
import { PairingScheduler, PairingService } from './pairing.service';

@Module({
  imports: [AuthModule, QueueModule, VisionModule],
  controllers: [PairingController],
  providers: [{ provide: PAIRING_QUEUE_TOKEN, useFactory: createPairingQueue }, PairingScheduler, PairingService, PairingProcessor],
  exports: [PAIRING_QUEUE_TOKEN, PairingScheduler, PairingProcessor],
})
export class PairingModule implements OnModuleDestroy {
  constructor(@Inject(PAIRING_QUEUE_TOKEN) private readonly queue: Queue<PairingJobData>) {}

  async onModuleDestroy() {
    await closePairingQueue(this.queue);
  }
}
```

`api/src/movements/movements.module.ts` : ajouter `PairingModule` aux `imports`.

`api/src/movements/movements.service.ts` :
- constructeur : ajouter un troisième paramètre `@Optional() private readonly pairings?: PairingScheduler` (import `Optional` de `@nestjs/common`, `PairingScheduler` de `../pairing/pairing.service`) et un `private readonly logger = new Logger(MovementsService.name);` ;
- dans `createIn`, remplacer `const { wine } = await this.matching.matchOrCreate(input.wine);` par `const { wine, created: wineCreated } = await this.matching.matchOrCreate(input.wine);` ;
- juste avant `return { movement, wine, stock: await this.stockOf(wine.id), created: true };` dans le bloc `try`, ajouter :

```ts
      // Nouveau vin : ses accords sont suggérés en tâche de fond. Une file
      // indisponible ne doit jamais faire échouer l'entrée — le rattrapage du
      // worker reprendra ce vin au prochain démarrage.
      if (wineCreated && this.pairings) {
        await this.pairings.schedule(wine.id).catch((e: unknown) =>
          this.logger.warn(`Accords de ${wine.id} non mis en file : ${e instanceof Error ? e.message : String(e)}`),
        );
      }
```

`api/src/app.module.ts` : importer `PairingModule` (`./pairing/pairing.module`, à sa place alphabétique) et l'ajouter aux `imports`.

`api/src/cave/cave.service.ts` :
- ajouter :

```ts
export interface PairingView { status: string; dishes: string[]; errorMessage: string | null; generatedAt: Date | null }

export function pairingOf(row: CaveDbRow): PairingView | null {
  return row.pairingStatus
    ? { status: row.pairingStatus, dishes: row.pairingDishes ?? [], errorMessage: row.pairingError ?? null, generatedAt: row.pairingGeneratedAt ?? null }
    : null;
}
```

- dans `detail`, rendre `wine: { ...toItem(row, rules, new Date().getFullYear()), pairing: pairingOf(row) }`.

`api/src/worker.ts` : après la création du worker d'extraction, ajouter un second worker et le rattrapage :

```ts
  const pairingProcessor = app.get(PairingProcessor);
  const pairingWorker = new Worker<PairingJobData>(
    PAIRING_QUEUE,
    (job) => pairingProcessor.process(job.data.wineId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
    {
      connection: redisConnection(),
      concurrency: 1,
      settings: { backoffStrategy: (attemptsMade: number) => extractionBackoffDelay(attemptsMade) },
    },
  );
  pairingWorker.on('failed', (job, err) => console.warn(`accords ${job?.id} : ${err.message}`));
  pairingWorker.on('error', (err) => console.error(`worker accords : ${err.message}`));
  console.log('worker prêt (wine-pairing, concurrence 1)');
```

après la reprise des photos orphelines :

```ts
  try {
    await requeueMissingPairings(app.get(PrismaService), app.get(PAIRING_QUEUE_TOKEN), (m) => console.log(m));
  } catch (e) {
    console.error(`rattrapage des accords impossible : ${(e as Error).message}`);
  }
```

et, dans `stop`, fermer aussi `pairingWorker` (`await pairingWorker.close();` avant `worker.close()`). Imports : `PairingProcessor` (`./pairing/pairing.processor`), `PAIRING_QUEUE`, `PAIRING_QUEUE_TOKEN`, `PairingJobData` (`./pairing/pairing.queue`), `requeueMissingPairings` (`./pairing/pairing-recovery`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx tsc --noEmit && npx eslint src --quiet && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest`
Expected: toute la suite passe. Si Nest signale une dépendance circulaire entre modules, la signaler (DONE_WITH_CONCERNS) avec le chemin exact plutôt que de restructurer au hasard.

- [ ] **Step 5: Commit**

```bash
git add api/src
git commit -m "feat(accords): génération en tâche de fond, rattrapage au démarrage et régénération

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Recherche par plat dans la cave (API)

**Files:**
- Create: `api/src/cave/dish-filter.ts`
- Modify: `api/src/cave/cave-filter.ts` (`CaveFilter.dish`), `api/src/cave/cave.service.ts` (`list`), `api/src/cave/cave.controller.ts` (paramètre `dish`)
- Test: `api/src/cave/dish-filter.spec.ts`, `api/src/cave/cave.service.spec.ts`, `api/src/app.e2e.spec.ts`

**Interfaces:**
- Consumes: `CaveDbRow.pairingDishes` (Task 2) ; `isDrinkSoon`, `sortByApogeeEnd` (apogee.ts) ; `normalizeLabel`.
- Produces: `export function matchDish(dishes: string[] | null | undefined, query: string): string | null` ; `GET /api/cave?dish=` ; `CaveItem.matchedDish`.

- [ ] **Step 1: Write the failing tests**

`api/src/cave/dish-filter.spec.ts` :

```ts
import { matchDish } from './dish-filter';

describe('matchDish', () => {
  const dishes = ['Agneau de sept heures', 'Côte d’agneau grillée', 'Daube provençale'];

  it('trouve sans tenir compte des accents ni des majuscules, et rend le premier plat qui correspond', () => {
    expect(matchDish(dishes, 'AGNEAU')).toBe('Agneau de sept heures');
    expect(matchDish(dishes, 'provencale')).toBe('Daube provençale');
  });

  it('exige tous les mots dans un même plat', () => {
    expect(matchDish(dishes, 'agneau grillee')).toBe('Côte d’agneau grillée');
    expect(matchDish(dishes, 'agneau daube')).toBeNull();
  });

  it('ne trouve rien sans accords ou sans mot', () => {
    expect(matchDish(null, 'agneau')).toBeNull();
    expect(matchDish(dishes, '  ')).toBeNull();
  });
});
```

Dans `api/src/cave/cave.service.spec.ts`, ajouter dans `describe('CaveService — apogée', …)` (temps fixé à 2026) :

```ts
  it('cherche par plat, à boire en priorité d’abord, et dit quel plat correspond', async () => {
    const at = (id: string, vintage: number, producer: string, dishes: string[] | null) => ({ ...cdp, id, vintage, producer, pairingDishes: dishes });
    const rows = [
      at('young', 2016, 'A', ['Gigot d’agneau']),       // fin 2036
      at('none', 2016, 'B', null),
      at('soon', 2006, 'C', ['Agneau de sept heures']), // fin 2026
      at('fish', 2006, 'D', ['Bar grillé']),
    ];
    const items = await service(null, rows).list({ dish: 'agneau' });
    expect(items.map((i) => [i.id, i.matchedDish])).toEqual([['soon', 'Agneau de sept heures'], ['young', 'Gigot d’agneau']]);
  });
```

Dans `api/src/app.e2e.spec.ts`, ajouter dans le cas `queues a pairing regeneration …` (avant `finally`) :

```ts
      await prisma.pairing.update({ where: { wineId: wine.id }, data: { status: 'DONE', dishes: ['Agneau de sept heures'] } });
      const found = await agent.get('/api/cave?dish=AGNEAU&includeEmpty=true');
      expect(found.status).toBe(200);
      expect(found.body.find((w: { id: string }) => w.id === wine.id)?.matchedDish).toBe('Agneau de sept heures');
      expect((await agent.get(`/api/cave?dish=${'x'.repeat(101)}`)).status).toBe(400);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/cave`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`api/src/cave/dish-filter.ts` :

```ts
import { normalizeLabel } from '../appellations/appellations.service';

/** Premier plat suggéré qui contient tous les mots cherchés, sans accents ni casse ; null sinon. */
export function matchDish(dishes: string[] | null | undefined, query: string): string | null {
  const words = normalizeLabel(query).split(' ').filter(Boolean);
  if (!words.length || !dishes) return null;
  return dishes.find((d) => {
    const haystack = normalizeLabel(d);
    return words.every((w) => haystack.includes(w));
  }) ?? null;
}
```

`api/src/cave/cave-filter.ts` : `CaveFilter` gagne `/** Plat à accompagner ; appliqué après le calcul de l'apogée. */ dish?: string;`.

`api/src/cave/cave.service.ts`, `list()` devient :

```ts
  async list(filter: CaveFilter): Promise<CaveItem[]> {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const year = new Date().getFullYear();
    const kept = filterCave(rows, filter);
    let items = kept.map((r) => toItem(r, rules, year));
    if (filter.drinkSoon) items = sortByApogeeEnd(items.filter((i) => isDrinkSoon(i.apogee, year)));
    else if (filter.noApogee) items = items.filter((i) => i.apogee.max == null);
    if (filter.dish) {
      const dishesById = new Map(kept.map((r) => [r.id, r.pairingDishes ?? null]));
      const query = filter.dish;
      items = items.flatMap((i) => {
        const matchedDish = matchDish(dishesById.get(i.id), query);
        return matchedDish ? [{ ...i, matchedDish }] : [];
      });
      // Pour un plat, les bouteilles à boire en priorité passent devant.
      const soon = sortByApogeeEnd(items.filter((i) => isDrinkSoon(i.apogee, year)));
      items = [...soon, ...items.filter((i) => !isDrinkSoon(i.apogee, year))];
    }
    return items;
  }
```

`api/src/cave/cave.controller.ts` : `listQuerySchema` gagne `dish: z.string().trim().max(100).optional(),` ; l'appel devient `this.cave.list({ q, color, includeEmpty: …, drinkSoon: …, noApogee: …, dish: dish || undefined })` (en ajoutant `dish` à la déstructuration de `parsed.data`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx tsc --noEmit && npx eslint src --quiet && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/cave api/src/app.e2e.spec.ts
git commit -m "feat(accords): chercher dans la cave un vin pour accompagner un plat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — note de dégustation (fiche, liste, statistiques)

**Files:**
- Modify: `web/src/lib/api-client.ts` (types `Rating`, `Pairing`, `CaveRow.rating`, `CaveRow.matchedDish`, `WineDetail.wine.pairing`, `CaveFilter.dish`, `Stats.bestRated`, fonctions `setRating`, `clearRating`, `regeneratePairing`, `getCave` avec `dish`)
- Create: `web/src/components/RatingBlock.tsx`, `web/src/lib/rating.ts`
- Modify: `web/src/pages/WinePage.tsx` (bloc après `ApogeeBlock`), `web/src/pages/CavePage.tsx` (note sur la ligne), `web/src/pages/StatsPage.tsx` (classement)
- Test: `web/src/components/RatingBlock.test.tsx`, `web/src/lib/rating.test.ts`, `web/src/pages/CavePage.test.tsx`, `web/src/pages/StatsPage.test.tsx`

**Interfaces:**
- Consumes: `PUT/DELETE /api/wines/:id/rating` (Task 2), `bestRated` (Task 3), `pairing` et `regenerate` (Task 5), `dish`/`matchedDish` (Task 6).
- Produces (api-client.ts) :
  - `export interface Rating { value: number; ratedAt: string; ratedBy: string | null }`
  - `export interface Pairing { status: 'PENDING' | 'DONE' | 'FAILED'; dishes: string[]; errorMessage: string | null; generatedAt: string | null }`
  - `CaveRow` gagne `rating?: Rating | null; matchedDish?: string` ; `WineDetail.wine` devient `CaveRow & { pairing?: Pairing | null }`
  - `CaveFilter` gagne `dish?: string` ; `getCave` ajoute `dish` à l'URL quand il est présent
  - `Stats` gagne `bestRated: StatsRankedWine[]`
  - `setRating(wineId, rating: number): Promise<Rating>`, `clearRating(wineId): Promise<null>`, `regeneratePairing(wineId): Promise<void>`
- Produces (rating.ts) : `formatRating(value: number): string` (« 16,5 / 20 ») et `parseRating(text: string): number | string` (nombre valide, ou message d'erreur français).

- [ ] **Step 1: Write the failing tests**

`web/src/lib/rating.test.ts` :

```ts
import { formatRating, parseRating } from './rating';

it('formate une note à la française', () => {
  expect(formatRating(16.5)).toBe('16,5 / 20');
  expect(formatRating(14)).toBe('14 / 20');
});

it('accepte une virgule ou un point, par demi-point, de 0 à 20', () => {
  expect(parseRating('16,5')).toBe(16.5);
  expect(parseRating(' 16.5 ')).toBe(16.5);
  expect(parseRating('0')).toBe(0);
  expect(parseRating('20')).toBe(20);
});

it('refuse le reste avec un message français', () => {
  expect(parseRating('')).toBe('La note doit être comprise entre 0 et 20');
  expect(parseRating('21')).toBe('La note doit être comprise entre 0 et 20');
  expect(parseRating('seize')).toBe('La note doit être comprise entre 0 et 20');
  expect(parseRating('16,3')).toBe('La note se donne par demi-point');
});
```

`web/src/components/RatingBlock.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { RatingBlock } from './RatingBlock';

afterEach(() => vi.restoreAllMocks());

const base: api.CaveRow = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  rating: null,
};
const mount = (wine: api.CaveRow) =>
  render(<QueryClientProvider client={new QueryClient()}><RatingBlock wine={wine} /></QueryClientProvider>);

it('propose de noter un vin non noté, puis enregistre une note avec virgule', async () => {
  const set = vi.spyOn(api, 'setRating').mockResolvedValue({ value: 16.5, ratedAt: '2026-10-05T10:00:00Z', ratedBy: 'Franck' });
  mount(base);
  await userEvent.click(screen.getByRole('button', { name: 'Noter ce vin' }));
  await userEvent.type(screen.getByLabelText('Note sur 20'), '16,5');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la note' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith('w1', 16.5));
});

it('bloque une note qui n’est pas un demi-point', async () => {
  mount(base);
  await userEvent.click(screen.getByRole('button', { name: 'Noter ce vin' }));
  await userEvent.type(screen.getByLabelText('Note sur 20'), '16,3');
  expect(screen.getByText('La note se donne par demi-point')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer la note' })).toBeDisabled();
});

it('affiche la note, sa date et son auteur, et la retire', async () => {
  const clear = vi.spyOn(api, 'clearRating').mockResolvedValue(null);
  mount({ ...base, rating: { value: 16.5, ratedAt: '2026-10-05T10:00:00Z', ratedBy: 'Franck' } });
  expect(screen.getByText('16,5 / 20')).toBeInTheDocument();
  expect(screen.getByText('notée le 5 oct. 2026 par Franck')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retirer' }));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('w1'));
});
```

Dans `web/src/pages/CavePage.test.tsx`, ajouter :

```tsx
it('montre la note sur la ligne d’un vin noté', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([{ ...rows[0], rating: { value: 16.5, ratedAt: '2026-10-05T10:00:00Z', ratedBy: null } }]);
  mount();
  const row = await screen.findByRole('link', { name: /Domaine Tempier/ });
  expect(within(row).getByText('16,5/20')).toBeInTheDocument();
});
```

Dans `web/src/pages/StatsPage.test.tsx` : ajouter `bestRated: [{ id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', vintage: 2019, value: 17.5 }]` à la fixture `base` (et `bestRated: []` à la fixture de la cave vide), puis :

```tsx
it('classe les mieux notés', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  const card = (await screen.findByRole('heading', { name: 'Les mieux notés' })).closest('section')!;
  expect(within(card).getByRole('link', { name: /Domaine Tempier — La Tourtine 2019/ })).toHaveAttribute('href', '/cave/w1');
  expect(within(card).getByText('17,5/20')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/rating.test.ts src/components/RatingBlock.test.tsx src/pages/CavePage.test.tsx src/pages/StatsPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`web/src/lib/rating.ts` :

```ts
const ONE_DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const RANGE = 'La note doit être comprise entre 0 et 20';

export const formatRating = (value: number) => `${ONE_DECIMAL.format(value)} / 20`;
/** Forme courte, pour une ligne de liste ou un classement. */
export const formatRatingShort = (value: number) => `${ONE_DECIMAL.format(value)}/20`;

/** Note saisie : virgule ou point, de 0 à 20 par demi-point ; sinon le message à afficher. */
export function parseRating(text: string): number | string {
  const t = text.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d+)?$/.test(t)) return RANGE;
  const value = Number(t);
  if (value < 0 || value > 20) return RANGE;
  if (!Number.isInteger(value * 2)) return 'La note se donne par demi-point';
  return value;
}
```

`web/src/lib/api-client.ts` — ajouter :

```ts
export interface Rating { value: number; ratedAt: string; ratedBy: string | null }
export interface Pairing { status: 'PENDING' | 'DONE' | 'FAILED'; dishes: string[]; errorMessage: string | null; generatedAt: string | null }
export const setRating = (wineId: string, rating: number) =>
  apiFetch<Rating>(`/wines/${wineId}/rating`, { method: 'PUT', body: JSON.stringify({ rating }) });
export const clearRating = (wineId: string) => apiFetch<null>(`/wines/${wineId}/rating`, { method: 'DELETE' });
export const regeneratePairing = (wineId: string) => apiFetch<void>(`/wines/${wineId}/pairing/regenerate`, { method: 'POST' });
```

et modifier : `CaveRow` (`rating?: Rating | null; matchedDish?: string;`), `WineDetail` (`wine: CaveRow & { pairing?: Pairing | null };`), `CaveFilter` (`dish?: string`), `getCave` (`if (filter.dish) q.set('dish', filter.dish);`), `Stats` (`bestRated: StatsRankedWine[];`). Vérifier que `apiFetch` accepte une réponse vide (`202` sans corps) pour `regeneratePairing` ; sinon, l'adapter pour qu'une réponse sans contenu rende `undefined`, avec un test dans `web/src/lib/api-client.test.ts`.

`web/src/components/RatingBlock.tsx` (même structure que `ApogeeBlock`) :

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CaveRow, clearRating, setRating } from '../lib/api-client';
import { formatRating, parseRating } from '../lib/rating';
import { Button } from './Button';

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

export function RatingBlock({ wine }: { wine: CaveRow }) {
  const qc = useQueryClient();
  const rating = wine.rating ?? null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verdict = parseRating(text);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'stats'].includes(String(q.queryKey[0])) });

  function open() {
    setText(rating ? String(rating.value).replace('.', ',') : '');
    setError(null);
    setEditing(true);
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Ma note</h3>
      {rating && !editing && (
        <>
          <p className="num" style={{ fontSize: 22, margin: 'var(--space-xs) 0' }}>{formatRating(rating.value)}</p>
          <p className="list__meta" style={{ margin: 0 }}>
            {`notée le ${DATE.format(new Date(rating.ratedAt))}${rating.ratedBy ? ` par ${rating.ratedBy}` : ''}`}
          </p>
        </>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
          <label className="field__label" htmlFor="rating-value">Note sur 20</label>
          <input id="rating-value" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="16,5" />
          {typeof verdict === 'string' && text.trim() !== '' && <p className="text-error" style={{ margin: 0 }}>{verdict}</p>}
          <Button variant="dark" disabled={busy || typeof verdict === 'string'} onClick={() => typeof verdict === 'number' && run(() => setRating(wine.id, verdict))}>
            Enregistrer la note
          </Button>
          <Button variant="link" onClick={() => { setEditing(false); setError(null); }}>Abandonner</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
          {rating ? (
            <>
              <Button variant="outline" onClick={open}>Modifier</Button>
              <Button variant="link" disabled={busy} onClick={() => run(() => clearRating(wine.id))}>Retirer</Button>
            </>
          ) : (
            <Button variant="outline" onClick={open}>Noter ce vin</Button>
          )}
        </div>
      )}
    </section>
  );
}
```

`web/src/pages/WinePage.tsx` : après `<ApogeeBlock key={`apogee-${wine.id}`} wine={wine} />`, ajouter `<RatingBlock key={`rating-${wine.id}`} wine={wine} />`.

`web/src/pages/CavePage.tsx` : dans la ligne d'un vin, après la mention d'apogée, ajouter :

```tsx
                {w.rating && <span className="list__meta num" style={{ display: 'block' }}>{formatRatingShort(w.rating.value)}</span>}
```

`web/src/pages/StatsPage.tsx` : après la liste *Les plus chères* :

```tsx
            <RankList title="Les mieux notés" items={s.bestRated.map((w) => ({ key: w.id, label: wineLabel(w), value: formatRatingShort(w.value), to: `/cave/${w.id}` }))} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(cave): noter un vin sur 20 depuis sa fiche, note visible dans la cave et les statistiques

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — accords sur la fiche et « Accompagner un plat »

**Files:**
- Create: `web/src/components/PairingBlock.tsx`
- Modify: `web/src/pages/WinePage.tsx` (bloc + rafraîchissement toutes les 5 s en attente), `web/src/pages/CavePage.tsx` (champ « Accompagner un plat », mention « avec : … »), `web/src/styles/base.css` (pastilles)
- Test: `web/src/components/PairingBlock.test.tsx`, `web/src/pages/WinePage.test.tsx` (s'il existe ; sinon dans `PairingBlock.test.tsx`), `web/src/pages/CavePage.test.tsx`

**Interfaces:**
- Consumes: `Pairing`, `regeneratePairing`, `CaveFilter.dish`, `CaveRow.matchedDish` (Task 7).
- Produces: `export const PAIRING_POLL_MS = 5000` et `export function pairingPollInterval(pairing: Pairing | null | undefined): number | false` (PairingBlock.tsx).

- [ ] **Step 1: Write the failing tests**

`web/src/components/PairingBlock.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { PairingBlock, pairingPollInterval } from './PairingBlock';

afterEach(() => vi.restoreAllMocks());

const mount = (pairing: api.Pairing | null) =>
  render(<QueryClientProvider client={new QueryClient()}><PairingBlock wineId="w1" pairing={pairing} /></QueryClientProvider>);

it('montre les plats suggérés et leur origine', () => {
  mount({ status: 'DONE', dishes: ['Agneau de sept heures', 'Daube provençale'], errorMessage: null, generatedAt: '2026-10-05T10:00:00Z' });
  expect(screen.getByText('Agneau de sept heures')).toBeInTheDocument();
  expect(screen.getByText('Suggestions générées par Gemini')).toBeInTheDocument();
});

it('dit que les suggestions sont en préparation, sans accords ou en attente', () => {
  mount(null);
  expect(screen.getByText('Suggestions en préparation…')).toBeInTheDocument();
});

it('dit pourquoi les suggestions manquent, et relance la génération', async () => {
  const regen = vi.spyOn(api, 'regeneratePairing').mockResolvedValue(undefined);
  mount({ status: 'FAILED', dishes: [], errorMessage: 'Réponse de Gemini inexploitable', generatedAt: null });
  expect(screen.getByText('Suggestions indisponibles')).toBeInTheDocument();
  expect(screen.getByText('Réponse de Gemini inexploitable')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Regénérer' }));
  await waitFor(() => expect(regen).toHaveBeenCalledWith('w1'));
});

it('rafraîchit la fiche toutes les 5 s tant que les suggestions sont en attente', () => {
  expect(pairingPollInterval(null)).toBe(5000);
  expect(pairingPollInterval({ status: 'PENDING', dishes: [], errorMessage: null, generatedAt: null })).toBe(5000);
  expect(pairingPollInterval({ status: 'DONE', dishes: ['x'], errorMessage: null, generatedAt: null })).toBe(false);
  expect(pairingPollInterval({ status: 'FAILED', dishes: [], errorMessage: 'x', generatedAt: null })).toBe(false);
});
```

Dans `web/src/pages/CavePage.test.tsx` :

```tsx
it('cherche un vin pour accompagner un plat et dit lequel correspond', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockImplementation(async (f) =>
    f.dish ? [{ ...rows[0], matchedDish: 'Agneau de sept heures' }] : rows,
  );
  mount();
  await screen.findByText(/Domaine Leflaive/);
  await userEvent.type(screen.getByLabelText('Accompagner un plat'), 'agneau');
  await waitFor(() => expect(getCave).toHaveBeenLastCalledWith(expect.objectContaining({ dish: 'agneau' })));
  const row = await screen.findByRole('link', { name: /Domaine Tempier/ });
  expect(within(row).getByText('avec : Agneau de sept heures')).toBeInTheDocument();
  expect(screen.queryByText(/Domaine Leflaive/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/PairingBlock.test.tsx src/pages/CavePage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`web/src/components/PairingBlock.tsx` :

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pairing, regeneratePairing } from '../lib/api-client';
import { Button } from './Button';

export const PAIRING_POLL_MS = 5000;

/** La fiche se rafraîchit tant que la génération n'a pas abouti (ou échoué). */
export function pairingPollInterval(pairing: Pairing | null | undefined): number | false {
  return !pairing || pairing.status === 'PENDING' ? PAIRING_POLL_MS : false;
}

export function PairingBlock({ wineId, pairing }: { wineId: string; pairing: Pairing | null | undefined }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      await regeneratePairing(wineId);
      void qc.invalidateQueries({ queryKey: ['wine', wineId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Relance impossible');
    } finally {
      setBusy(false);
    }
  }

  const pending = !pairing || pairing.status === 'PENDING';
  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Accords mets-vins</h3>
      {pending && <p className="list__meta">Suggestions en préparation…</p>}
      {pairing?.status === 'DONE' && (
        <>
          <ul className="dish-pills">
            {pairing.dishes.map((d) => <li key={d} className="dish-pill">{d}</li>)}
          </ul>
          <p className="list__meta" style={{ margin: 0 }}>Suggestions générées par Gemini</p>
        </>
      )}
      {pairing?.status === 'FAILED' && (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>Suggestions indisponibles</p>
          {pairing.errorMessage && <p className="list__meta" style={{ margin: 0 }}>{pairing.errorMessage}</p>}
        </>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      {!pending && (
        <Button variant="link" disabled={busy} onClick={regenerate}>Regénérer</Button>
      )}
    </section>
  );
}
```

`web/src/styles/base.css` (à la fin) :

```css
.dish-pills { list-style: none; margin: var(--space-sm) 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.dish-pill { padding: 4px 10px; border-radius: 999px; background: var(--color-surface-container-low); border: 1px solid var(--color-outline-subtle); font-size: 13px; }
```

`web/src/pages/WinePage.tsx` :
- la requête de la fiche devient `useQuery({ queryKey: ['wine', wineId], queryFn: () => getWine(wineId), refetchInterval: (q) => pairingPollInterval(q.state.data?.wine.pairing) })` ;
- après `<RatingBlock … />`, ajouter `<PairingBlock key={`pairing-${wine.id}`} wineId={wine.id} pairing={wine.pairing} />`.

`web/src/pages/CavePage.tsx` :
- état `const [dish, setDish] = useState('');` ;
- `base` devient `{ q, color: color || undefined, includeEmpty, ...(dish.trim() ? { dish: dish.trim() } : {}) }` ;
- sous le champ de recherche :

```tsx
          <input type="search" value={dish} onChange={(e) => setDish(e.target.value)} placeholder="Agneau, comté, poisson…" aria-label="Accompagner un plat" />
```

- sur la ligne d'un vin, après la note :

```tsx
                {w.matchedDish && <span className="list__meta" style={{ display: 'block' }}>{`avec : ${w.matchedDish}`}</span>}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit -p . && npx eslint src --quiet`
Expected: PASS ; sortie sans avertissement `act()` venant des nouveaux tests.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(accords): accords mets-vins sur la fiche et recherche « Accompagner un plat »

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Documentation et essai dans le navigateur

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

- ligne « **État** » : ajouter « lots 4b et 4c (note de dégustation, accords mets-vins) » aux lots livrés, et « note de dégustation, accords mets-vins » à l'énumération ;
- dans « Fonctionnalités », après le paragraphe **Statistiques.**, ajouter :

```markdown
**Note de dégustation.** Sur la fiche d'un vin, le bloc *Ma note* permet à
tout compte actif de noter le vin **sur 20, par demi-point** (« 16,5 » ou
« 16.5 » acceptés) ; la note remplace la précédente et peut être retirée. Elle
s'affiche avec sa date et son auteur, sur la ligne du vin dans l'onglet Cave,
dans la colonne *Note /20* de l'export Excel et dans le classement *Les mieux
notés* de la page Stats. API : `PUT` et `DELETE /api/wines/:id/rating`.

**Accords mets-vins.** Chaque vin reçoit, en tâche de fond, de 5 à 8 plats
suggérés par Gemini (file `wine-pairing` du worker, à la création du vin et au
démarrage du worker pour les vins qui n'en ont pas encore). Comme pour les
photos, une indisponibilité de Gemini relance la génération plus tard sans
rien bloquer, et le plafond mensuel `GEMINI_MONTHLY_CAP_CENTS` compte photos et
accords ensemble. La fiche affiche les plats (« Suggestions générées par
Gemini »), « Suggestions en préparation… » en attendant, et *Regénérer*
(`POST /api/wines/:id/pairing/regenerate`). Dans l'onglet Cave, le champ
**Accompagner un plat** garde les vins dont un plat suggéré contient les mots
tapés (sans accents ni majuscules), les bouteilles à boire en priorité en
premier, avec la mention « avec : … » (`GET /api/cave?dish=`). L'export ajoute
une colonne *Accords*.
```

- dans « Limites », ajouter :

```markdown
- **Accords suggérés, jamais saisis** : les plats viennent de Gemini et ne se
  corrigent pas un à un (seulement *Regénérer*) ; aucun accord « vécu » n'est
  enregistré. Une régénération remplace le coût de la précédente dans le
  plafond du mois.
- **Une seule note par vin**, sans commentaire ni historique.
```

- [ ] **Step 2: Essai dans le navigateur à 375 px**

Construire et lancer l'api sur `cave_test` (port 3000) et le serveur web (`.claude/launch.json`, `web`), se connecter avec le compte de secours local, puis vérifier : noter un vin (« 16,5 »), voir la note sur la fiche, dans la liste et dans *Les mieux notés* ; poser un accord à la main en base de test (`UPDATE pairing SET status='DONE', dishes='{"Agneau de sept heures"}' WHERE wine_id=…`), le voir sur la fiche et le trouver par « agneau » dans l'onglet Cave. Arrêter l'api ensuite.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note de dégustation et accords mets-vins dans le README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
