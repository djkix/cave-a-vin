# Lot 2b — l'apogée : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estimer l'apogée de chaque vin par règles (garde × qualité du millésime), l'afficher en fourchette avec confiance et statut, permettre la correction manuelle par vin et l'ajustement des règles par les administrateurs, et l'exporter.

**Architecture:** Une fonction pure `estimateApogee` (module `api/src/apogee/`) calcule la fourchette à la lecture à partir des colonnes du vin, de la garde du référentiel et de deux tables de règles (`vintage_quality`, `guard_override`) chargées par `ApogeeRulesService`. `CaveService` (liste, fiche) et `ExportService` l'appellent ; seule la correction manuelle est écrite sur le vin. Un contrôleur d'administration gère les règles ; le web ajoute un bloc Apogée sur la fiche, une mention dans la liste et deux sections d'administration.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL 16, Jest ; React 18, TanStack Query 5, Vitest + Testing Library ; ExcelJS.

**Spec:** [`docs/superpowers/specs/2026-10-04-cave-a-vin-lot2b-apogee-design.md`](../specs/2026-10-04-cave-a-vin-lot2b-apogee-design.md)

## Global Constraints

- Tous les textes d'interface, messages d'erreur, commentaires et messages de commit sont **en français**.
- Fourchette : `[round(millésime + garde_min × f) ; round(millésime + garde_max × f)]`, `round` = `Math.round`.
- Facteurs exacts : `GRAND` 1.2, `MOYEN` 1.0, `FAIBLE` 0.85 ; millésime absent de `vintage_quality` = non qualifié, facteur 1.0.
- Priorité de la garde : (1) ajustement appellation + couleur ; (2) rosé → 1 à 3 ans ; (3) ajustement appellation toutes couleurs ; (4) garde du référentiel.
- Confiance : `SAISIE` (correction manuelle), `MOYENNE` (règle, millésime qualifié), `FAIBLE` (règle, millésime non qualifié).
- Absences : `NON_MILLESIME`, `APPELLATION_INCONNUE`, `GARDE_INCONNUE` — jamais de fourchette inventée.
- Statuts selon l'année `a` : `TROP_JEUNE` (`a < min`), `A_BOIRE` (`min ≤ a < max`), `A_BOIRE_VITE` (`a = max`), `PASSEE` (`a > max`).
- Droits : règles (`/admin/vintages`, `/admin/guards`) réservées aux administrateurs (`AuthenticatedGuard` + `AdminGuard`) ; correction de l'apogée d'un vin ouverte à toute session active.
- Validations : correction de vin entiers 1900–2200 et `min ≤ max` ; millésime 1900 à l'année en cours + 1 ; garde entiers 0–100 et `min ≤ max`.
- Les ajustements de garde vivent dans `guard_override`, jamais sur la ligne `appellation` (le référentiel est rechargé à chaque démarrage par `AppellationsModule.onModuleInit`).
- Index uniques partiels et SQL particuliers écrits à la main dans la migration ; seulement `prisma migrate deploy`.
- Aucune nouvelle variable d'environnement ; `docker-compose.yml` inchangé.
- Commandes : API `cd api && npx jest <fichier>` ; intégration `DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test npx jest <fichier>` ; web `cd web && npx vitest run <fichier>` ; lint `npm run lint` ; types `npx tsc --noEmit` (web) / `npx tsc --noEmit -p tsconfig.build.json` (api).
- Commits `feat:` / `fix:` pour le code (ils déclenchent la version 1.3.0), `docs:` / `test:` / `chore:` sinon ; terminer chaque message par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Un ajustement de garde doit survivre au redémarrage** (rechargement du référentiel) → test d'intégration en tâche 1.
2. **Une règle modifiée change immédiatement la fourchette** affichée (aucun cache entre requêtes) → test de `CaveService` en tâche 4.
3. **Correction manuelle sur un vin non millésimé ou d'appellation inconnue** → acceptée et affichée en `SAISIE` → tests en tâches 2 et 4.
4. **Région avec accent ou tiret** (« Rhône », « Languedoc-Roussillon ») dans `DELETE /admin/vintages/:region/:year` → encodée côté web, décodée côté api → tests en tâches 3 et 7.
5. **Compte non administrateur** qui écrit une règle → `403` → test HTTP en tâche 3.

---

## Structure des fichiers

| Fichier | Rôle |
| --- | --- |
| `api/prisma/schema.prisma` | enum `VintageQualityLevel`, modèles `VintageQuality`, `GuardOverride` |
| `api/prisma/migrations/20261005000000_lot2b_apogee/migration.sql` | tables, enum, index partiels |
| `api/src/prisma/apogee.integration.spec.ts` | survie au rechargement, unicité |
| `api/src/apogee/apogee.ts` (+ spec) | fonction pure, types, constantes |
| `api/src/apogee/dto.ts` (+ spec) | schémas zod des trois saisies |
| `api/src/apogee/apogee-rules.service.ts` | chargement des règles |
| `api/src/apogee/apogee-admin.service.ts` (+ spec) / `apogee-admin.controller.ts` / `apogee.module.ts` | administration des règles |
| `api/src/cave/*` | apogée dans la liste et la fiche, correction manuelle |
| `api/src/export/*` | colonnes et mise en évidence |
| `web/src/lib/api-client.ts`, `web/src/lib/apogee.ts` (+ test) | types, appels, libellés |
| `web/src/components/ApogeeBlock.tsx` (+ test) | bloc de la fiche |
| `web/src/components/admin/VintagesSection.tsx`, `GuardsSection.tsx` (+ tests) | administration |
| `web/src/pages/WinePage.tsx`, `CavePage.tsx`, `AdminPage.tsx` | câblage |
| `README.md`, `CHANGELOG.md` | documentation |

---

### Task 1: Base de données — tables de règles

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20261005000000_lot2b_apogee/migration.sql`
- Create: `api/src/prisma/apogee.integration.spec.ts`

**Interfaces:**
- Produces: enum Prisma `VintageQualityLevel` (`GRAND` | `MOYEN` | `FAIBLE`) ; modèle `VintageQuality { region, year, quality, updatedAt }` (id composé `region_year`) ; modèle `GuardOverride { id, appellationId, appellation, color: WineColor | null, guardMinYears, guardMaxYears, updatedAt }` ; relation `Appellation.guardOverrides`.

- [ ] **Step 1: Test d'intégration (échoue tant que les tables n'existent pas)**

`api/src/prisma/apogee.integration.spec.ts` :

```ts
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppellationsService } from '../appellations/appellations.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('règles d’apogée (base réelle)', () => {
  const prisma = new PrismaClient();
  const name = `AOC essai apogée ${Date.now()}`;
  let appellationId: string;

  beforeAll(async () => {
    const a = await prisma.appellation.create({ data: { canonicalName: name, region: 'Essai', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 2, guardMaxYears: 6 } });
    appellationId = a.id;
  });

  afterAll(async () => {
    await prisma.guardOverride.deleteMany({ where: { appellationId } });
    await prisma.appellation.delete({ where: { id: appellationId } });
    await prisma.vintageQuality.deleteMany({ where: { region: 'Essai' } });
    await prisma.$disconnect();
  });

  it('garde un ajustement de garde quand le référentiel est rechargé au démarrage', async () => {
    await prisma.guardOverride.create({ data: { appellationId, color: null, guardMinYears: 5, guardMaxYears: 15 } });
    // Rechargement tel que le fait AppellationsModule.onModuleInit, avec la garde du fichier.
    const dir = mkdtempSync(join(tmpdir(), 'ref-'));
    const file = join(dir, 'appellations.json');
    writeFileSync(file, JSON.stringify([{ canonicalName: name, region: 'Essai', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 2, guardMaxYears: 6 }]));
    await new AppellationsService(prisma as never).seedFromFile(file);
    const overrides = await prisma.guardOverride.findMany({ where: { appellationId } });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ guardMinYears: 5, guardMaxYears: 15, color: null });
  });

  it('refuse un second ajustement toutes couleurs pour la même appellation', async () => {
    await expect(prisma.guardOverride.create({ data: { appellationId, color: null, guardMinYears: 1, guardMaxYears: 2 } })).rejects.toThrow();
  });

  it('accepte un ajustement par couleur à côté de l’ajustement toutes couleurs, mais pas deux pour la même couleur', async () => {
    await prisma.guardOverride.create({ data: { appellationId, color: 'ROSE', guardMinYears: 1, guardMaxYears: 3 } });
    await expect(prisma.guardOverride.create({ data: { appellationId, color: 'ROSE', guardMinYears: 2, guardMaxYears: 4 } })).rejects.toThrow();
  });

  it('qualifie un millésime par région et par année, une seule fois', async () => {
    await prisma.vintageQuality.create({ data: { region: 'Essai', year: 2016, quality: 'GRAND' } });
    await expect(prisma.vintageQuality.create({ data: { region: 'Essai', year: 2016, quality: 'FAIBLE' } })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `cd api && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test npx jest src/prisma/apogee.integration.spec.ts`
Expected: FAIL — erreur TypeScript « Property 'guardOverride' does not exist on type 'PrismaClient' ».

- [ ] **Step 3: Schéma Prisma**

Dans `api/prisma/schema.prisma`, ajouter après `enum PhotoPurpose { … }` :

```prisma
enum VintageQualityLevel {
  GRAND
  MOYEN
  FAIBLE
}
```

Dans `model Appellation`, après `wines         Wine[]` :

```prisma
  guardOverrides GuardOverride[]
```

À la fin du fichier :

```prisma
/// Qualité d'un millésime pour une région. Absent = non qualifié (facteur 1,0).
model VintageQuality {
  region    String
  year      Int
  quality   VintageQualityLevel
  updatedAt DateTime            @updatedAt @map("updated_at")

  @@id([region, year])
  @@map("vintage_quality")
}

/// Ajustement de garde posé par un administrateur. Vit hors de la ligne
/// `appellation`, que le rechargement du référentiel réécrit à chaque démarrage.
/// `color` vide = toutes couleurs. Unicité par index partiels (migration).
model GuardOverride {
  id            String      @id @default(uuid())
  appellationId String      @map("appellation_id")
  appellation   Appellation @relation(fields: [appellationId], references: [id], onDelete: Cascade)
  color         WineColor?
  guardMinYears Int         @map("guard_min_years")
  guardMaxYears Int         @map("guard_max_years")
  updatedAt     DateTime    @updatedAt @map("updated_at")

  @@map("guard_override")
}
```

- [ ] **Step 4: Migration écrite à la main**

`api/prisma/migrations/20261005000000_lot2b_apogee/migration.sql` :

```sql
-- Lot 2b — l'apogée. Règles d'estimation modifiables par les administrateurs.

CREATE TYPE "VintageQualityLevel" AS ENUM ('GRAND', 'MOYEN', 'FAIBLE');

-- Qualité d'un millésime par région ; une région/année absente est « non qualifiée ».
CREATE TABLE "vintage_quality" (
  "region" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "quality" "VintageQualityLevel" NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vintage_quality_pkey" PRIMARY KEY ("region", "year")
);

-- Ajustements de garde. Hors de la table « appellation », que le
-- rechargement du référentiel réécrit à chaque démarrage de l'api.
CREATE TABLE "guard_override" (
  "id" TEXT NOT NULL,
  "appellation_id" TEXT NOT NULL,
  "color" "WineColor",
  "guard_min_years" INTEGER NOT NULL,
  "guard_max_years" INTEGER NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guard_override_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guard_override_appellation_id_fkey" FOREIGN KEY ("appellation_id") REFERENCES "appellation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "guard_override_range_check" CHECK ("guard_min_years" >= 0 AND "guard_max_years" <= 100 AND "guard_min_years" <= "guard_max_years")
);

-- Un seul ajustement « toutes couleurs » par appellation, un seul par
-- (appellation, couleur). Une contrainte unique ordinaire laisserait passer
-- plusieurs lignes à couleur NULL.
CREATE UNIQUE INDEX idx_guard_override_all_colors ON "guard_override" ("appellation_id") WHERE "color" IS NULL;
CREATE UNIQUE INDEX idx_guard_override_color ON "guard_override" ("appellation_id", "color") WHERE "color" IS NOT NULL;
```

- [ ] **Step 5: Générer, appliquer, vérifier**

Run: `cd api && npx prisma generate && npx prisma validate && npx tsc --noEmit -p tsconfig.build.json && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test npx prisma migrate deploy && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test npx jest src/prisma/ && npx jest`
Expected: migration appliquée ; les suites d'intégration de `src/prisma/` passent ; la suite unitaire reste verte.

- [ ] **Step 6: Commit**

```bash
git add api/prisma api/src/prisma/apogee.integration.spec.ts
git commit -m "feat(apogee): tables des règles de garde et de qualité des millésimes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fonction de calcul de l'apogée

**Files:**
- Create: `api/src/apogee/apogee.ts`, `api/src/apogee/apogee.spec.ts`

**Interfaces:**
- Produces:
  - `type VintageQualityLevel = 'GRAND' | 'MOYEN' | 'FAIBLE'`, `type ApogeeConfidence = 'SAISIE' | 'MOYENNE' | 'FAIBLE'`, `type ApogeeStatus = 'TROP_JEUNE' | 'A_BOIRE' | 'A_BOIRE_VITE' | 'PASSEE'`, `type ApogeeReason = 'NON_MILLESIME' | 'APPELLATION_INCONNUE' | 'GARDE_INCONNUE'`
  - `interface Apogee { min: number | null; max: number | null; confidence: ApogeeConfidence | null; status: ApogeeStatus | null; reason: ApogeeReason | null; source: 'MANUEL' | 'REGLE' | null }`
  - `interface ApogeeWineInput { vintage: number | null; color: string; appellationId: string | null; region: string | null; referenceGuardMin: number | null; referenceGuardMax: number | null; apogeeMin: number | null; apogeeMax: number | null; apogeeSource: string | null }`
  - `interface ApogeeRules { guardOverrides: Array<{ appellationId: string; color: string | null; min: number; max: number }>; vintageQualities: Array<{ region: string; year: number; quality: VintageQualityLevel }> }`
  - `interface CompiledApogeeRules` (opaque), `compileApogeeRules(raw: ApogeeRules): CompiledApogeeRules`, `EMPTY_APOGEE_RULES: CompiledApogeeRules`
  - `estimateApogee(wine: ApogeeWineInput, rules: CompiledApogeeRules, currentYear: number): Apogee`
  - `apogeeStatus(min: number, max: number, currentYear: number): ApogeeStatus`
  - constantes `VINTAGE_FACTOR`, `ROSE_GUARD`

- [ ] **Step 1: Tests**

`api/src/apogee/apogee.spec.ts` :

```ts
import { apogeeStatus, ApogeeWineInput, compileApogeeRules, EMPTY_APOGEE_RULES, estimateApogee } from './apogee';

const YEAR = 2026;
const wine = (over: Partial<ApogeeWineInput> = {}): ApogeeWineInput => ({
  vintage: 2016, color: 'ROUGE', appellationId: 'cdp', region: 'Rhône', referenceGuardMin: 8, referenceGuardMax: 20,
  apogeeMin: null, apogeeMax: null, apogeeSource: null, ...over,
});
const rules = (over: Partial<Parameters<typeof compileApogeeRules>[0]> = {}) =>
  compileApogeeRules({ guardOverrides: [], vintageQualities: [], ...over });

describe('estimateApogee — exemples de référence de la spécification', () => {
  it('Châteauneuf-du-Pape 2016 non qualifié : 2024-2036, confiance faible', () => {
    expect(estimateApogee(wine(), EMPTY_APOGEE_RULES, YEAR)).toEqual({
      min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE',
    });
  });

  it('Rhône 2016 grand millésime : 2026-2040, confiance moyenne', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2026, max: 2040, confidence: 'MOYENNE' });
  });

  it('Rhône 2016 faible : 2023-2033, confiance moyenne', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'FAIBLE' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2023, max: 2033, confidence: 'MOYENNE' });
  });

  it('un millésime qualifié « moyen » donne la même fourchette mais une confiance moyenne', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'MOYEN' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2024, max: 2036, confidence: 'MOYENNE' });
  });

  it('Rosé de Provence 2023 : 2024-2026', () => {
    const w = wine({ vintage: 2023, color: 'ROSE', appellationId: 'provence', region: 'Provence', referenceGuardMin: 1, referenceGuardMax: 3 });
    expect(estimateApogee(w, EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2024, max: 2026 });
  });

  it('Alsace 2020 rosé : plafonné à 1-3 ans (2021-2023), pas la garde de l’appellation 1-8', () => {
    const w = wine({ vintage: 2020, color: 'ROSE', appellationId: 'alsace', region: 'Alsace', referenceGuardMin: 1, referenceGuardMax: 8 });
    expect(estimateApogee(w, EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2021, max: 2023 });
  });

  it('Alsace 2020 rosé avec ajustement Alsace/ROSE 2-4 : 2022-2024 (l’ajustement par couleur passe avant le rosé)', () => {
    const w = wine({ vintage: 2020, color: 'ROSE', appellationId: 'alsace', region: 'Alsace', referenceGuardMin: 1, referenceGuardMax: 8 });
    const r = rules({ guardOverrides: [{ appellationId: 'alsace', color: 'ROSE', min: 2, max: 4 }] });
    expect(estimateApogee(w, r, YEAR)).toMatchObject({ min: 2022, max: 2024 });
  });

  it('Meursault 2019 blanc avec ajustement toutes couleurs 4-12 : 2023-2031', () => {
    const w = wine({ vintage: 2019, color: 'BLANC', appellationId: 'meursault', region: 'Bourgogne', referenceGuardMin: 3, referenceGuardMax: 10 });
    const r = rules({ guardOverrides: [{ appellationId: 'meursault', color: null, min: 4, max: 12 }] });
    expect(estimateApogee(w, r, YEAR)).toMatchObject({ min: 2023, max: 2031 });
  });

  it('vin non millésimé : aucune estimation', () => {
    expect(estimateApogee(wine({ vintage: null }), EMPTY_APOGEE_RULES, YEAR)).toEqual({
      min: null, max: null, confidence: null, status: null, reason: 'NON_MILLESIME', source: null,
    });
  });

  it('correction manuelle 2030-2035 sur le Châteauneuf : elle prime, confiance « saisie »', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] });
    expect(estimateApogee(wine({ apogeeMin: 2030, apogeeMax: 2035, apogeeSource: 'MANUEL' }), r, YEAR)).toEqual({
      min: 2030, max: 2035, confidence: 'SAISIE', status: 'TROP_JEUNE', reason: null, source: 'MANUEL',
    });
  });
});

describe('estimateApogee — priorités et absences', () => {
  it('l’ajustement par couleur passe avant l’ajustement toutes couleurs', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'cdp', color: null, min: 1, max: 2 }, { appellationId: 'cdp', color: 'ROUGE', min: 10, max: 30 }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2026, max: 2046 });
  });

  it('le rosé passe avant l’ajustement toutes couleurs', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'cdp', color: null, min: 10, max: 30 }] });
    expect(estimateApogee(wine({ color: 'ROSE' }), r, YEAR)).toMatchObject({ min: 2017, max: 2019 });
  });

  it('l’ajustement toutes couleurs passe avant la garde du référentiel', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'cdp', color: null, min: 10, max: 30 }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2026, max: 2046 });
  });

  it('un ajustement d’une autre appellation ne s’applique pas', () => {
    const r = rules({ guardOverrides: [{ appellationId: 'autre', color: null, min: 10, max: 30 }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2024, max: 2036 });
  });

  it('appellation non reconnue : aucune estimation, même pour un rosé', () => {
    expect(estimateApogee(wine({ appellationId: null, color: 'ROSE' }), EMPTY_APOGEE_RULES, YEAR).reason).toBe('APPELLATION_INCONNUE');
  });

  it('appellation sans garde ni ajustement : aucune estimation', () => {
    expect(estimateApogee(wine({ referenceGuardMin: null, referenceGuardMax: null }), EMPTY_APOGEE_RULES, YEAR).reason).toBe('GARDE_INCONNUE');
  });

  it('une appellation sans région n’est jamais qualifiée : facteur 1, confiance faible', () => {
    const r = rules({ vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] });
    expect(estimateApogee(wine({ region: null }), r, YEAR)).toMatchObject({ min: 2024, max: 2036, confidence: 'FAIBLE' });
  });

  it('la qualité d’une autre région ou d’une autre année ne s’applique pas', () => {
    const r = rules({ vintageQualities: [{ region: 'Bordeaux', year: 2016, quality: 'GRAND' }, { region: 'Rhône', year: 2015, quality: 'GRAND' }] });
    expect(estimateApogee(wine(), r, YEAR)).toMatchObject({ min: 2024, max: 2036, confidence: 'FAIBLE' });
  });

  it('une correction manuelle vaut aussi pour un vin non millésimé ou d’appellation inconnue', () => {
    const manual = { apogeeMin: 2027, apogeeMax: 2029, apogeeSource: 'MANUEL' };
    expect(estimateApogee(wine({ vintage: null, ...manual }), EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2027, max: 2029, confidence: 'SAISIE', source: 'MANUEL' });
    expect(estimateApogee(wine({ appellationId: null, ...manual }), EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2027, confidence: 'SAISIE' });
  });

  it('ignore une correction incomplète et revient à la règle', () => {
    expect(estimateApogee(wine({ apogeeMin: 2030, apogeeMax: null, apogeeSource: 'MANUEL' }), EMPTY_APOGEE_RULES, YEAR)).toMatchObject({ min: 2024, source: 'REGLE' });
  });
});

describe('apogeeStatus', () => {
  it.each([
    [2027, 2034, 2026, 'TROP_JEUNE'],
    [2024, 2036, 2024, 'A_BOIRE'],
    [2024, 2036, 2035, 'A_BOIRE'],
    [2024, 2036, 2036, 'A_BOIRE_VITE'],
    [2026, 2026, 2026, 'A_BOIRE_VITE'],
    [2020, 2025, 2026, 'PASSEE'],
  ])('min %i, max %i, année %i → %s', (min, max, year, expected) => {
    expect(apogeeStatus(min, max, year)).toBe(expected);
  });
});
```

- [ ] **Step 2: Les voir échouer**

Run: `cd api && npx jest src/apogee/apogee.spec.ts`
Expected: FAIL — « Cannot find module './apogee' ».

- [ ] **Step 3: Implémentation**

`api/src/apogee/apogee.ts` :

```ts
/**
 * Estimation de l'apogée par règles, calculée à la lecture.
 *
 * Fonction pure : la liste de la cave, la fiche vin et l'export l'appellent
 * avec les règles du moment, si bien qu'une règle modifiée change toutes les
 * fourchettes immédiatement, sans recalcul ni valeur périmée. Seule la
 * correction manuelle est stockée sur le vin, et elle prime toujours.
 */

export type VintageQualityLevel = 'GRAND' | 'MOYEN' | 'FAIBLE';
export type ApogeeConfidence = 'SAISIE' | 'MOYENNE' | 'FAIBLE';
export type ApogeeStatus = 'TROP_JEUNE' | 'A_BOIRE' | 'A_BOIRE_VITE' | 'PASSEE';
export type ApogeeReason = 'NON_MILLESIME' | 'APPELLATION_INCONNUE' | 'GARDE_INCONNUE';

export interface Apogee {
  min: number | null;
  max: number | null;
  confidence: ApogeeConfidence | null;
  status: ApogeeStatus | null;
  reason: ApogeeReason | null;
  source: 'MANUEL' | 'REGLE' | null;
}

export interface ApogeeWineInput {
  vintage: number | null;
  color: string;
  appellationId: string | null;
  region: string | null;
  referenceGuardMin: number | null;
  referenceGuardMax: number | null;
  apogeeMin: number | null;
  apogeeMax: number | null;
  apogeeSource: string | null;
}

export interface ApogeeRules {
  guardOverrides: Array<{ appellationId: string; color: string | null; min: number; max: number }>;
  vintageQualities: Array<{ region: string; year: number; quality: VintageQualityLevel }>;
}

interface Guard {
  min: number;
  max: number;
}

export interface CompiledApogeeRules {
  readonly guards: ReadonlyMap<string, Guard>;
  readonly qualities: ReadonlyMap<string, VintageQualityLevel>;
}

export const VINTAGE_FACTOR: Record<VintageQualityLevel, number> = { GRAND: 1.2, MOYEN: 1.0, FAIBLE: 0.85 };

/** Un rosé se boit jeune, quelle que soit la garde de son appellation. */
export const ROSE_GUARD: Guard = { min: 1, max: 3 };

const ALL_COLORS = '*';
const guardKey = (appellationId: string, color: string | null) => `${appellationId}|${color ?? ALL_COLORS}`;
const qualityKey = (region: string, year: number) => `${region}|${year}`;

export function compileApogeeRules(raw: ApogeeRules): CompiledApogeeRules {
  return {
    guards: new Map(raw.guardOverrides.map((g) => [guardKey(g.appellationId, g.color), { min: g.min, max: g.max }])),
    qualities: new Map(raw.vintageQualities.map((q) => [qualityKey(q.region, q.year), q.quality])),
  };
}

export const EMPTY_APOGEE_RULES: CompiledApogeeRules = compileApogeeRules({ guardOverrides: [], vintageQualities: [] });

export function apogeeStatus(min: number, max: number, currentYear: number): ApogeeStatus {
  if (currentYear < min) return 'TROP_JEUNE';
  if (currentYear > max) return 'PASSEE';
  if (currentYear === max) return 'A_BOIRE_VITE';
  return 'A_BOIRE';
}

function none(reason: ApogeeReason): Apogee {
  return { min: null, max: null, confidence: null, status: null, reason, source: null };
}

/** Garde retenue, de la règle la plus précise à la plus générale. */
function guardFor(wine: ApogeeWineInput, rules: CompiledApogeeRules): Guard | null {
  if (!wine.appellationId) return null;
  const byColor = rules.guards.get(guardKey(wine.appellationId, wine.color));
  if (byColor) return byColor;
  if (wine.color === 'ROSE') return ROSE_GUARD;
  const allColors = rules.guards.get(guardKey(wine.appellationId, null));
  if (allColors) return allColors;
  if (wine.referenceGuardMin == null || wine.referenceGuardMax == null) return null;
  return { min: wine.referenceGuardMin, max: wine.referenceGuardMax };
}

export function estimateApogee(wine: ApogeeWineInput, rules: CompiledApogeeRules, currentYear: number): Apogee {
  if (wine.apogeeSource === 'MANUEL' && wine.apogeeMin != null && wine.apogeeMax != null) {
    return {
      min: wine.apogeeMin, max: wine.apogeeMax, confidence: 'SAISIE',
      status: apogeeStatus(wine.apogeeMin, wine.apogeeMax, currentYear), reason: null, source: 'MANUEL',
    };
  }
  if (wine.vintage == null) return none('NON_MILLESIME');
  if (!wine.appellationId) return none('APPELLATION_INCONNUE');
  const guard = guardFor(wine, rules);
  if (!guard) return none('GARDE_INCONNUE');

  const quality = wine.region ? rules.qualities.get(qualityKey(wine.region, wine.vintage)) : undefined;
  const factor = quality ? VINTAGE_FACTOR[quality] : 1;
  const min = Math.round(wine.vintage + guard.min * factor);
  const max = Math.round(wine.vintage + guard.max * factor);
  return {
    min, max, confidence: quality ? 'MOYENNE' : 'FAIBLE',
    status: apogeeStatus(min, max, currentYear), reason: null, source: 'REGLE',
  };
}
```

- [ ] **Step 4: Lancer les tests**

Run: `cd api && npx jest src/apogee/apogee.spec.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/apogee/apogee.ts api/src/apogee/apogee.spec.ts
git commit -m "feat(apogee): estimer la fourchette d'apogée par règles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Règles — chargement et administration

**Files:**
- Create: `api/src/apogee/dto.ts`, `api/src/apogee/dto.spec.ts`
- Create: `api/src/apogee/apogee-rules.service.ts`
- Create: `api/src/apogee/apogee-admin.service.ts`, `api/src/apogee/apogee-admin.service.spec.ts`
- Create: `api/src/apogee/apogee-admin.controller.ts`, `api/src/apogee/apogee.module.ts`
- Modify: `api/src/app.module.ts`, `api/src/app.e2e.spec.ts`

**Interfaces:**
- Consumes: `compileApogeeRules`, `CompiledApogeeRules`, `VintageQualityLevel` (tâche 2) ; modèles `VintageQuality`, `GuardOverride` (tâche 1).
- Produces:
  - `manualApogeeSchema` (`{ min, max }`), `vintageQualitySchema` (`{ region, year, quality }`), `guardOverrideSchema` (`{ appellationId, color?, min, max }`) dans `api/src/apogee/dto.ts`
  - `ApogeeRulesService.load(): Promise<CompiledApogeeRules>` (exporté par `ApogeeModule`)
  - Routes : `GET /admin/vintages` → `{ regions: string[]; qualities: Array<{ region; year; quality }> }` ; `PUT /admin/vintages` → `{ region; year; quality }` ; `DELETE /admin/vintages/:region/:year` → 204 ; `GET /admin/guards?q=` → `Array<{ id; canonicalName; region; guardMinYears; guardMaxYears; overrides: Array<{ id; color; min; max }> }>` ; `PUT /admin/guards` → `{ id; color; min; max }` ; `DELETE /admin/guards/:id` → 204

- [ ] **Step 1: Tests des schémas**

`api/src/apogee/dto.spec.ts` :

```ts
import { guardOverrideSchema, manualApogeeSchema, vintageQualitySchema } from './dto';

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message));

describe('manualApogeeSchema', () => {
  it('accepte une fourchette valide', () => {
    expect(manualApogeeSchema.safeParse({ min: 2027, max: 2034 }).success).toBe(true);
  });
  it('accepte une fourchette d’une seule année', () => {
    expect(manualApogeeSchema.safeParse({ min: 2030, max: 2030 }).success).toBe(true);
  });
  it('refuse une fin avant le début, en français', () => {
    expect(messages(manualApogeeSchema.safeParse({ min: 2034, max: 2027 }))).toEqual(['L’année de début doit précéder ou égaler l’année de fin']);
  });
  it.each([[1899, 2000], [2000, 2201], [2027.5, 2030]])('refuse %p-%p', (min, max) => {
    expect(manualApogeeSchema.safeParse({ min, max }).success).toBe(false);
  });
  it('refuse des champs absents avec des messages français', () => {
    expect(messages(manualApogeeSchema.safeParse({}))).toEqual(['Année de début requise', 'Année de fin requise']);
  });
});

describe('vintageQualitySchema', () => {
  it('accepte un millésime qualifié', () => {
    expect(vintageQualitySchema.safeParse({ region: 'Rhône', year: 2016, quality: 'GRAND' }).success).toBe(true);
  });
  it('refuse une année dans plus d’un an', () => {
    expect(messages(vintageQualitySchema.safeParse({ region: 'Rhône', year: new Date().getFullYear() + 2, quality: 'GRAND' }))).toEqual(['Année dans le futur']);
  });
  it('refuse une qualité inconnue en français', () => {
    expect(messages(vintageQualitySchema.safeParse({ region: 'Rhône', year: 2016, quality: 'EXCEPTIONNEL' }))).toEqual(['Qualité inconnue']);
  });
});

describe('guardOverrideSchema', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('accepte un ajustement toutes couleurs et un ajustement par couleur', () => {
    expect(guardOverrideSchema.safeParse({ appellationId: id, min: 4, max: 12 }).success).toBe(true);
    expect(guardOverrideSchema.safeParse({ appellationId: id, color: 'ROSE', min: 1, max: 3 }).success).toBe(true);
  });
  it('refuse une garde minimale supérieure à la maximale', () => {
    expect(messages(guardOverrideSchema.safeParse({ appellationId: id, min: 9, max: 3 }))).toEqual(['La garde minimale doit être inférieure ou égale à la maximale']);
  });
  it.each([[-1, 3], [1, 101]])('refuse la garde %p-%p', (min, max) => {
    expect(guardOverrideSchema.safeParse({ appellationId: id, min, max }).success).toBe(false);
  });
  it('refuse une couleur inconnue', () => {
    expect(guardOverrideSchema.safeParse({ appellationId: id, color: 'ORANGE', min: 1, max: 3 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Tests du service d'administration**

`api/src/apogee/apogee-admin.service.spec.ts` :

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApogeeAdminService } from './apogee-admin.service';

function fakePrisma() {
  const qualities = new Map<string, any>();
  const overrides: any[] = [];
  const appellations = [
    { id: 'a1', canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', guardMinYears: 8, guardMaxYears: 20 },
    { id: 'a2', canonicalName: 'Bandol', region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
    { id: 'a3', canonicalName: 'Faugères', region: 'Languedoc-Roussillon', guardMinYears: 3, guardMaxYears: 8 },
  ];
  return {
    qualities, overrides,
    appellation: {
      findMany: jest.fn(async (args: any) => {
        if (args?.distinct) return [...new Set(appellations.map((a) => a.region))].sort().map((region) => ({ region }));
        return appellations.map((a) => ({ ...a, guardOverrides: overrides.filter((o) => o.appellationId === a.id) }));
      }),
      findUnique: jest.fn(async ({ where }: any) => appellations.find((a) => a.id === where.id) ?? null),
    },
    vintageQuality: {
      findMany: jest.fn(async () => [...qualities.values()]),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.region_year.region}|${where.region_year.year}`;
        const row = { ...(qualities.get(key) ?? create), ...update };
        qualities.set(key, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const deleted = qualities.delete(`${where.region}|${where.year}`);
        return { count: deleted ? 1 : 0 };
      }),
    },
    guardOverride: {
      findFirst: jest.fn(async ({ where }: any) => overrides.find((o) => o.appellationId === where.appellationId && o.color === where.color) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `o${overrides.length + 1}`, ...data };
        overrides.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(overrides.find((o) => o.id === where.id), data)),
      delete: jest.fn(async ({ where }: any) => {
        const i = overrides.findIndex((o) => o.id === where.id);
        if (i < 0) throw new Prisma.PrismaClientKnownRequestError('absent', { code: 'P2025', clientVersion: 'test' });
        return overrides.splice(i, 1)[0];
      }),
    },
  };
}

describe('ApogeeAdminService — millésimes', () => {
  it('liste les régions du référentiel et les millésimes qualifiés', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setVintage({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    expect(await s.listVintages()).toEqual({
      regions: ['Languedoc-Roussillon', 'Provence', 'Rhône'],
      qualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }],
    });
  });

  it('remplace la qualité d’un millésime déjà qualifié', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setVintage({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    await s.setVintage({ region: 'Rhône', year: 2016, quality: 'FAIBLE' });
    expect((await s.listVintages()).qualities).toEqual([{ region: 'Rhône', year: 2016, quality: 'FAIBLE' }]);
  });

  it('refuse une région absente du référentiel', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    await expect(s.setVintage({ region: 'Atlantide', year: 2016, quality: 'GRAND' })).rejects.toThrow(new BadRequestException('Région inconnue du référentiel'));
  });

  it('remet un millésime à « non qualifié », y compris pour une région à tiret', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setVintage({ region: 'Languedoc-Roussillon', year: 2016, quality: 'GRAND' });
    await s.removeVintage('Languedoc-Roussillon', 2016);
    expect((await s.listVintages()).qualities).toEqual([]);
  });
});

describe('ApogeeAdminService — gardes', () => {
  it('cherche une appellation sans accents et montre garde et ajustements', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    await s.setGuard({ appellationId: 'a1', color: null, min: 10, max: 25 });
    expect(await s.searchGuards('chateauneuf')).toEqual([
      { id: 'a1', canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', guardMinYears: 8, guardMaxYears: 20, overrides: [{ id: 'o1', color: null, min: 10, max: 25 }] },
    ]);
  });

  it('crée puis remplace l’ajustement d’une même appellation et couleur', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    const first = await s.setGuard({ appellationId: 'a2', color: 'ROSE', min: 1, max: 3 });
    const second = await s.setGuard({ appellationId: 'a2', color: 'ROSE', min: 2, max: 4 });
    expect(second.id).toBe(first.id);
    expect(p.overrides).toHaveLength(1);
    expect(second).toEqual({ id: first.id, color: 'ROSE', min: 2, max: 4 });
  });

  it('distingue l’ajustement toutes couleurs de l’ajustement par couleur', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setGuard({ appellationId: 'a2', color: null, min: 6, max: 18 });
    await s.setGuard({ appellationId: 'a2', color: 'ROSE', min: 1, max: 3 });
    expect(p.overrides).toHaveLength(2);
  });

  it('refuse une appellation inconnue', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    await expect(s.setGuard({ appellationId: 'zz', color: null, min: 1, max: 2 })).rejects.toThrow(new NotFoundException('Appellation introuvable'));
  });

  it('retire un ajustement, et répond 404 s’il n’existe pas', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    const o = await s.setGuard({ appellationId: 'a1', color: null, min: 10, max: 25 });
    await s.removeGuard(o.id);
    await expect(s.removeGuard(o.id)).rejects.toThrow(new NotFoundException('Ajustement introuvable'));
  });
});
```

- [ ] **Step 3: Test HTTP des droits**

Dans `api/src/app.e2e.spec.ts`, ajouter juste après le test « lists accounts for the break-glass admin … » :

```ts
  it('lets an admin qualify a vintage, then return it to « non qualifié »', async () => {
    const put = await agent.put('/api/admin/vintages').send({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    expect(put.status).toBe(200);
    const list = await agent.get('/api/admin/vintages');
    expect(list.body.regions).toContain('Rhône');
    expect(list.body.qualities).toContainEqual({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    const del = await agent.delete(`/api/admin/vintages/${encodeURIComponent('Rhône')}/2016`);
    expect(del.status).toBe(204);
  });
```

et juste après le test « refuses the admin listing to an authenticated but non-admin account » (le compte n'y est plus administrateur) :

```ts
  it('refuses the apogee rules to an authenticated but non-admin account', async () => {
    expect((await agent.put('/api/admin/vintages').send({ region: 'Rhône', year: 2016, quality: 'GRAND' })).status).toBe(403);
    expect((await agent.get('/api/admin/guards?q=bandol')).status).toBe(403);
  });
```

- [ ] **Step 4: Les voir échouer**

Run: `cd api && npx jest src/apogee/`
Expected: FAIL — modules `./dto` et `./apogee-admin.service` introuvables.

- [ ] **Step 5: Schémas**

`api/src/apogee/dto.ts` :

```ts
import { z } from 'zod';

const year = (label: string) =>
  z.number({ required_error: `${label} requise`, invalid_type_error: `${label} invalide` }).int(`${label} : année entière attendue`);

export const manualApogeeSchema = z
  .object({
    min: year('Année de début').min(1900, 'Année de début trop ancienne').max(2200, 'Année de début trop lointaine'),
    max: year('Année de fin').min(1900, 'Année de fin trop ancienne').max(2200, 'Année de fin trop lointaine'),
  })
  .refine((d) => d.min <= d.max, { message: 'L’année de début doit précéder ou égaler l’année de fin', path: ['max'] });

export type ManualApogeeInput = z.infer<typeof manualApogeeSchema>;

export const vintageQualitySchema = z.object({
  region: z.string({ required_error: 'Région requise', invalid_type_error: 'Région invalide' }).trim().min(1, 'Région requise'),
  year: z
    .number({ required_error: 'Année requise', invalid_type_error: 'Année invalide' })
    .int('Année entière attendue')
    .min(1900, 'Année trop ancienne')
    // Lu à chaque validation, et non au chargement du module : l'api tourne
    // parfois d'une année sur l'autre sans redémarrer.
    .refine((y) => y <= new Date().getFullYear() + 1, 'Année dans le futur'),
  quality: z.enum(['GRAND', 'MOYEN', 'FAIBLE'], { errorMap: () => ({ message: 'Qualité inconnue' }) }),
});

export type VintageQualityInput = z.infer<typeof vintageQualitySchema>;

const guardYears = (label: string) =>
  z
    .number({ required_error: `${label} requise`, invalid_type_error: `${label} invalide` })
    .int(`${label} : nombre d’années entier attendu`)
    .min(0, `${label} : pas de garde négative`)
    .max(100, `${label} : 100 ans au plus`);

export const guardOverrideSchema = z
  .object({
    appellationId: z.string({ required_error: 'Appellation requise', invalid_type_error: 'Appellation invalide' }).uuid('Appellation invalide'),
    color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT'], { errorMap: () => ({ message: 'Couleur inconnue' }) }).nullish(),
    min: guardYears('Garde minimale'),
    max: guardYears('Garde maximale'),
  })
  .refine((d) => d.min <= d.max, { message: 'La garde minimale doit être inférieure ou égale à la maximale', path: ['max'] });

export type GuardOverrideInput = z.infer<typeof guardOverrideSchema>;
```

Note : le test du service appelle `setGuard({ appellationId: 'a2', … })` avec des identifiants courts ; le service ne revalide pas l'UUID (c'est le contrôleur qui valide l'entrée). Le service reçoit le type `{ appellationId: string; color: WineColor | null | undefined; min: number; max: number }`.

- [ ] **Step 6: Chargement des règles**

`api/src/apogee/apogee-rules.service.ts` :

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { compileApogeeRules, CompiledApogeeRules } from './apogee';

/**
 * Règles du moment, relues à chaque requête : une qualité de millésime ou une
 * garde modifiée se voit dès l'affichage suivant. Deux petites tables, lues en
 * parallèle — aucun cache, donc aucune valeur périmée possible.
 */
@Injectable()
export class ApogeeRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<CompiledApogeeRules> {
    const [overrides, qualities] = await Promise.all([this.prisma.guardOverride.findMany(), this.prisma.vintageQuality.findMany()]);
    return compileApogeeRules({
      guardOverrides: overrides.map((o) => ({ appellationId: o.appellationId, color: o.color, min: o.guardMinYears, max: o.guardMaxYears })),
      vintageQualities: qualities.map((q) => ({ region: q.region, year: q.year, quality: q.quality })),
    });
  }
}
```

- [ ] **Step 7: Administration**

`api/src/apogee/apogee-admin.service.ts` :

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WineColor } from '@prisma/client';
import { normalizeLabel } from '../appellations/appellations.service';
import { PrismaService } from '../prisma/prisma.service';
import { VintageQualityInput } from './dto';

const SEARCH_LIMIT = 20;

export interface GuardInput {
  appellationId: string;
  color: WineColor | null | undefined;
  min: number;
  max: number;
}

@Injectable()
export class ApogeeAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private async regions(): Promise<string[]> {
    const rows = await this.prisma.appellation.findMany({
      where: { region: { not: null } },
      select: { region: true },
      distinct: ['region'],
      orderBy: { region: 'asc' },
    });
    return rows.map((r) => r.region as string);
  }

  async listVintages() {
    const [regions, qualities] = await Promise.all([
      this.regions(),
      this.prisma.vintageQuality.findMany({ orderBy: [{ region: 'asc' }, { year: 'desc' }] }),
    ]);
    return { regions, qualities: qualities.map((q) => ({ region: q.region, year: q.year, quality: q.quality })) };
  }

  async setVintage(input: VintageQualityInput) {
    if (!(await this.regions()).includes(input.region)) throw new BadRequestException('Région inconnue du référentiel');
    const row = await this.prisma.vintageQuality.upsert({
      where: { region_year: { region: input.region, year: input.year } },
      create: { region: input.region, year: input.year, quality: input.quality },
      update: { quality: input.quality },
    });
    return { region: row.region, year: row.year, quality: row.quality };
  }

  async removeVintage(region: string, year: number): Promise<void> {
    await this.prisma.vintageQuality.deleteMany({ where: { region, year } });
  }

  async searchGuards(q: string) {
    const words = normalizeLabel(q).split(' ').filter(Boolean);
    const all = await this.prisma.appellation.findMany({ include: { guardOverrides: true }, orderBy: { canonicalName: 'asc' } });
    return all
      .filter((a) => words.every((w) => normalizeLabel(a.canonicalName).includes(w)))
      .slice(0, SEARCH_LIMIT)
      .map((a) => ({
        id: a.id, canonicalName: a.canonicalName, region: a.region,
        guardMinYears: a.guardMinYears, guardMaxYears: a.guardMaxYears,
        overrides: a.guardOverrides.map((o) => ({ id: o.id, color: o.color, min: o.guardMinYears, max: o.guardMaxYears })),
      }));
  }

  async setGuard(input: GuardInput) {
    const appellation = await this.prisma.appellation.findUnique({ where: { id: input.appellationId } });
    if (!appellation) throw new NotFoundException('Appellation introuvable');
    const color = input.color ?? null;
    const data = { guardMinYears: input.min, guardMaxYears: input.max };
    const existing = await this.prisma.guardOverride.findFirst({ where: { appellationId: input.appellationId, color } });
    let row;
    if (existing) {
      row = await this.prisma.guardOverride.update({ where: { id: existing.id }, data });
    } else {
      try {
        row = await this.prisma.guardOverride.create({ data: { appellationId: input.appellationId, color, ...data } });
      } catch (e) {
        // Deux administrateurs au même instant : l'index partiel a refusé le
        // second ajout ; on met à jour la ligne écrite par le premier.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const raced = await this.prisma.guardOverride.findFirst({ where: { appellationId: input.appellationId, color } });
        if (!raced) throw e;
        row = await this.prisma.guardOverride.update({ where: { id: raced.id }, data });
      }
    }
    return { id: row.id, color: row.color, min: row.guardMinYears, max: row.guardMaxYears };
  }

  async removeGuard(id: string): Promise<void> {
    try {
      await this.prisma.guardOverride.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Ajustement introuvable');
      throw e;
    }
  }
}
```

`api/src/apogee/apogee-admin.controller.ts` :

```ts
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { ApogeeAdminService } from './apogee-admin.service';
import { guardOverrideSchema, vintageQualitySchema } from './dto';

const issues = (e: { issues: { message: string }[] }) => e.issues.map((i) => i.message).join(' ; ');

/** Règles d'apogée : elles changent toute la cave, d'où la garde administrateur. */
@Controller('admin')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class ApogeeAdminController {
  constructor(private readonly admin: ApogeeAdminService) {}

  @Get('vintages')
  listVintages() {
    return this.admin.listVintages();
  }

  @Put('vintages')
  setVintage(@Body() body: unknown) {
    const parsed = vintageQualitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(issues(parsed.error));
    return this.admin.setVintage(parsed.data);
  }

  @Delete('vintages/:region/:year')
  @HttpCode(204)
  removeVintage(@Param('region') region: string, @Param('year', ParseIntPipe) year: number) {
    return this.admin.removeVintage(region, year);
  }

  @Get('guards')
  searchGuards(@Query('q') q?: string) {
    return this.admin.searchGuards(q ?? '');
  }

  @Put('guards')
  setGuard(@Body() body: unknown) {
    const parsed = guardOverrideSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(issues(parsed.error));
    return this.admin.setGuard(parsed.data);
  }

  @Delete('guards/:id')
  @HttpCode(204)
  removeGuard(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.removeGuard(id);
  }
}
```

`api/src/apogee/apogee.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApogeeAdminController } from './apogee-admin.controller';
import { ApogeeAdminService } from './apogee-admin.service';
import { ApogeeRulesService } from './apogee-rules.service';

@Module({
  imports: [AuthModule],
  controllers: [ApogeeAdminController],
  providers: [ApogeeRulesService, ApogeeAdminService],
  exports: [ApogeeRulesService],
})
export class ApogeeModule {}
```

Dans `api/src/app.module.ts`, importer `ApogeeModule` (`import { ApogeeModule } from './apogee/apogee.module';`) et l'ajouter au tableau `imports` après `AdminModule`.

- [ ] **Step 8: Lancer les tests**

Run: `cd api && npx jest && npm run lint && npx tsc --noEmit -p tsconfig.build.json && npm run build`
puis, Redis local démarré (`redis-server --daemonize yes`) : `DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest src/app.e2e.spec.ts`
Expected: PASS, y compris les deux nouveaux tests HTTP.

- [ ] **Step 9: Commit**

```bash
git add api/src/apogee api/src/app.module.ts api/src/app.e2e.spec.ts
git commit -m "feat(apogee): administrer la qualité des millésimes et les gardes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Apogée dans la cave et correction manuelle

**Files:**
- Modify: `api/src/cave/cave-filter.ts`, `api/src/cave/cave.service.ts`, `api/src/cave/cave.service.spec.ts`, `api/src/cave/cave.controller.ts`, `api/src/cave/cave.module.ts`

**Interfaces:**
- Consumes: `estimateApogee`, `Apogee`, `ApogeeWineInput`, `compileApogeeRules`, `EMPTY_APOGEE_RULES` (tâche 2) ; `ApogeeRulesService`, `ApogeeModule`, `manualApogeeSchema` (tâche 3).
- Produces:
  - `type CaveItem = CaveRow & { apogee: Apogee }` (exporté par `cave.service.ts`)
  - `GET /cave` → `CaveItem[]` ; `GET /wines/:id` → `{ wine: CaveItem; movements }`
  - `PUT /wines/:id/apogee` (`{ min, max }`) → `Apogee` ; `DELETE /wines/:id/apogee` → `Apogee`

- [ ] **Step 1: Tests**

Dans `api/src/cave/cave.service.spec.ts` :
- remplacer la construction du service par une fonction qui fournit des règles :

```ts
import { compileApogeeRules } from '../apogee/apogee';
```

```ts
function service(photo: any, rows: any[] = [tempier19], rules = compileApogeeRules({ guardOverrides: [], vintageQualities: [] })) {
  const prisma = {
    $queryRaw: jest.fn(async () => rows),
    photo: { findUnique: jest.fn(async () => photo) },
    movement: { findMany: jest.fn(async () => []) },
    wine: { update: jest.fn(async ({ where }: any) => (rows.some((r) => r.id === where.id) ? {} : Promise.reject(new Prisma.PrismaClientKnownRequestError('absent', { code: 'P2025', clientVersion: 'test' })))) },
  };
  return new CaveService(prisma as any, { load: async () => rules } as any);
}
```

(ajouter `import { Prisma } from '@prisma/client';` en tête) ;
- dans le test « renvoie le vin avec son stock et ses derniers mouvements », remplacer `expect(r.wine).toEqual(tempier19);` par `expect(r.wine).toMatchObject(tempier19);` ;
- ajouter :

```ts
const cdp = {
  id: 'w16', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
  color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  appellationId: 'a-cdp', region: 'Rhône', referenceGuardMin: 8, referenceGuardMax: 20, apogeeMin: null, apogeeMax: null, apogeeSource: null,
};

describe('CaveService — apogée', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-06-01')));
  afterAll(() => jest.useRealTimers());

  it('calcule l’apogée de chaque vin de la liste', async () => {
    const [item] = await service(null, [cdp]).list({});
    expect(item.apogee).toEqual({ min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' });
  });

  it('n’expose pas les champs internes du calcul', async () => {
    const [item] = await service(null, [cdp]).list({});
    expect(item).not.toHaveProperty('referenceGuardMin');
    expect(item).not.toHaveProperty('apogeeSource');
    expect(item).not.toHaveProperty('region');
  });

  it('applique immédiatement une règle modifiée (aucun cache entre deux requêtes)', async () => {
    const loads = [
      compileApogeeRules({ guardOverrides: [], vintageQualities: [] }),
      compileApogeeRules({ guardOverrides: [], vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] }),
    ];
    const prisma = { $queryRaw: jest.fn(async () => [cdp]), movement: { findMany: jest.fn(async () => []) } };
    const s = new CaveService(prisma as any, { load: async () => loads.shift()! } as any);
    expect((await s.detail('w16')).wine.apogee).toMatchObject({ min: 2024, max: 2036 });
    expect((await s.detail('w16')).wine.apogee).toMatchObject({ min: 2026, max: 2040, confidence: 'MOYENNE' });
  });

  it('montre la correction manuelle, même pour un vin non millésimé', async () => {
    const nv = { ...cdp, vintage: null, apogeeMin: 2027, apogeeMax: 2029, apogeeSource: 'MANUEL' };
    expect((await service(null, [nv]).detail('w16')).wine.apogee).toMatchObject({ min: 2027, max: 2029, confidence: 'SAISIE' });
  });

  it('enregistre une correction manuelle', async () => {
    const s = service(null, [cdp]);
    await s.setManualApogee('w16', { min: 2030, max: 2035 });
    expect((s as any).prisma.wine.update).toHaveBeenCalledWith({ where: { id: 'w16' }, data: { apogeeMin: 2030, apogeeMax: 2035, apogeeSource: 'MANUEL' } });
  });

  it('retire la correction manuelle', async () => {
    const s = service(null, [cdp]);
    await s.clearManualApogee('w16');
    expect((s as any).prisma.wine.update).toHaveBeenCalledWith({ where: { id: 'w16' }, data: { apogeeMin: null, apogeeMax: null, apogeeSource: null } });
  });

  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, [cdp]).setManualApogee('nope', { min: 2030, max: 2035 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Les voir échouer**

Run: `cd api && npx jest src/cave/`
Expected: FAIL — `item.apogee` indéfini, `setManualApogee` absent.

- [ ] **Step 3: Filtre générique**

Dans `api/src/cave/cave-filter.ts`, rendre le filtre générique pour qu'il conserve les champs supplémentaires des lignes :

```ts
export function filterCave<T extends CaveRow>(rows: T[], filter: CaveFilter): T[] {
```

- [ ] **Step 4: Service**

Dans `api/src/cave/cave.service.ts` :

```ts
import { Apogee, ApogeeWineInput, CompiledApogeeRules, estimateApogee } from '../apogee/apogee';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { ManualApogeeInput } from '../apogee/dto';
import { Prisma } from '@prisma/client';
```

```ts
/** Ligne lue en base : la ligne publique plus ce qu'il faut pour estimer l'apogée. */
type CaveDbRow = CaveRow & Omit<ApogeeWineInput, 'vintage' | 'color'>;

export type CaveItem = CaveRow & { apogee: Apogee };

function toItem(row: CaveDbRow, rules: CompiledApogeeRules, currentYear: number): CaveItem {
  const { appellationId, region, referenceGuardMin, referenceGuardMax, apogeeMin, apogeeMax, apogeeSource, ...pub } = row;
  const apogee = estimateApogee(
    { vintage: row.vintage, color: row.color, appellationId: appellationId ?? null, region: region ?? null,
      referenceGuardMin: referenceGuardMin ?? null, referenceGuardMax: referenceGuardMax ?? null,
      apogeeMin: apogeeMin ?? null, apogeeMax: apogeeMax ?? null, apogeeSource: apogeeSource ?? null },
    rules, currentYear,
  );
  return { ...pub, apogee };
}
```

Le constructeur devient :

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: ApogeeRulesService,
  ) {}
```

`allWithStock` lit aussi l'appellation et la correction :

```ts
  allWithStock(): Promise<CaveDbRow[]> {
    return this.prisma.$queryRaw<CaveDbRow[]>`
      SELECT w.id, w.producer, w.cuvee, w.appellation_raw AS "appellationRaw", w.vintage,
             w.color::TEXT AS color, w.format_cl AS "formatCl", w.reference_photo_id AS "referencePhotoId",
             COALESCE(s.quantity, 0)::INTEGER AS quantity,
             w.appellation_id AS "appellationId", a.region,
             a.guard_min_years AS "referenceGuardMin", a.guard_max_years AS "referenceGuardMax",
             w.apogee_min AS "apogeeMin", w.apogee_max AS "apogeeMax", w.apogee_source AS "apogeeSource"
      FROM wine w
      LEFT JOIN stock_courant s ON s.wine_id = w.id
      LEFT JOIN appellation a ON a.id = w.appellation_id
      ORDER BY w.producer ASC, w.vintage ASC NULLS FIRST`;
  }
```

`list` et `detail` :

```ts
  async list(filter: CaveFilter): Promise<CaveItem[]> {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const year = new Date().getFullYear();
    return filterCave(rows, filter).map((r) => toItem(r, rules, year));
  }

  async detail(id: string) {
    const [rows, rules] = await Promise.all([this.allWithStock(), this.rules.load()]);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException('Vin introuvable');
    const movements = await this.prisma.movement.findMany({
      where: { wineId: id },
      orderBy: { occurredAt: 'desc' },
      take: 10,
      select: { id: true, delta: true, type: true, occurredAt: true, note: true, reversesId: true },
    });
    return { wine: toItem(row, rules, new Date().getFullYear()), movements };
  }
```

Dans `exitCandidates`, ne plus étaler la ligne de base (elle porte maintenant des champs internes) :

```ts
    const inStock = (await this.allWithStock())
      .filter((r) => r.quantity > 0)
      .map((r) => ({
        wine: { id: r.id, producer: r.producer, cuvee: r.cuvee, appellationRaw: r.appellationRaw, vintage: r.vintage, color: r.color, formatCl: r.formatCl },
        quantity: r.quantity,
        referencePhotoId: r.referencePhotoId,
      }));
```

Correction manuelle :

```ts
  async setManualApogee(id: string, input: ManualApogeeInput): Promise<Apogee> {
    await this.updateApogee(id, { apogeeMin: input.min, apogeeMax: input.max, apogeeSource: 'MANUEL' });
    return (await this.detail(id)).wine.apogee;
  }

  async clearManualApogee(id: string): Promise<Apogee> {
    await this.updateApogee(id, { apogeeMin: null, apogeeMax: null, apogeeSource: null });
    return (await this.detail(id)).wine.apogee;
  }

  private async updateApogee(id: string, data: { apogeeMin: number | null; apogeeMax: number | null; apogeeSource: string | null }) {
    try {
      await this.prisma.wine.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Vin introuvable');
      throw e;
    }
  }
```

(Dans les tests, `detail` après `setManualApogee` lit le même faux `$queryRaw` : la ligne n'est pas modifiée, ce qui suffit à vérifier l'appel à `wine.update`.)

- [ ] **Step 5: Contrôleur et module**

Dans `api/src/cave/cave.controller.ts`, importer `Delete`, `Put` depuis `@nestjs/common` et `manualApogeeSchema` depuis `'../apogee/dto'`, puis ajouter :

```ts
  @Put('wines/:id/apogee')
  setApogee(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = manualApogeeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.cave.setManualApogee(id, parsed.data);
  }

  @Delete('wines/:id/apogee')
  clearApogee(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.clearManualApogee(id);
  }
```

Dans `api/src/cave/cave.module.ts`, ajouter `ApogeeModule` aux `imports` (`import { ApogeeModule } from '../apogee/apogee.module';`).

- [ ] **Step 6: Lancer les tests et vérifier la requête sur la vraie base**

Run: `cd api && npx jest && npm run lint && npx tsc --noEmit -p tsconfig.build.json && npm run build`
Puis exécuter une fois la requête de `allWithStock` contre `cave_test` (psql) pour vérifier les alias, et consigner la sortie dans le rapport.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/cave
git commit -m "feat(apogee): apogée dans la liste et la fiche, correction manuelle par vin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Export Excel

**Files:**
- Modify: `api/src/export/export.service.ts`, `api/src/export/export.service.spec.ts`, `api/src/export/export.module.ts`

**Interfaces:**
- Consumes: `estimateApogee`, `ApogeeRulesService`, `ApogeeModule`, `compileApogeeRules`.
- Produces: feuille *Stock* avec colonnes 6 *Apogée min*, 7 *Apogée max*, 8 *Confiance* (après *Millésime*, colonne 5) ; *Quantité* passe en colonne 11, *Valeur d'achat* en 13 ; lignes `PASSEE` sur fond `FFFCE4D6`.

- [ ] **Step 1: Tests**

Dans `api/src/export/export.service.spec.ts` :
- importer `import { compileApogeeRules } from '../apogee/apogee';` et définir `const noRules = { load: async () => compileApogeeRules({ guardOverrides: [], vintageQualities: [] }) };` ;
- remplacer chaque `new ExportService(prisma as any)` par `new ExportService(prisma as any, noRules as any)` ;
- dans le premier test, remplacer `getCell(8).value).toBe(12)` par `getCell(11).value).toBe(12)` et `getCell(10).value).toBe(576)` par `getCell(13).value).toBe(576)` ;
- dans `fakePrisma`, donner au vin `w1` les champs de l'apogée : `appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 }` ;
- ajouter :

```ts
  it('ajoute l’apogée estimée et sa confiance après le millésime', async () => {
    const { buffer } = await new ExportService(fakePrisma() as any, noRules as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect([6, 7, 8].map((c) => stock.getRow(1).getCell(c).value)).toEqual(['Apogée min', 'Apogée max', 'Confiance']);
    // Bandol 2019, garde 5-20, millésime non qualifié.
    expect([6, 7, 8].map((c) => stock.getRow(2).getCell(c).value)).toEqual([2024, 2039, 'Faible']);
  });

  it('met en évidence une ligne dont l’apogée est passée', async () => {
    const prisma = fakePrisma();
    const old = { id: 'w9', producer: 'Vieux Domaine', cuvee: null, appellationRaw: 'Bandol', vintage: 2000, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 } };
    prisma.wine.findMany = async () => [old] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w9', quantity: 1 }];
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const row = wb.getWorksheet('Stock')!.getRow(2);
    expect(row.getCell(7).value).toBe(2020);
    expect((row.getCell(1).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFFCE4D6');
  });

  it('laisse l’apogée vide pour un vin sans estimation', async () => {
    const prisma = fakePrisma();
    const nv = { id: 'w8', producer: 'Champagne Essai', cuvee: null, appellationRaw: 'Champagne', vintage: null, color: 'PETILLANT', formatCl: 75,
      appellationId: 'a-ch', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Champagne', guardMinYears: 1, guardMaxYears: 4 } };
    prisma.wine.findMany = async () => [nv] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w8', quantity: 3 }];
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    expect([6, 7, 8].map((c) => wb.getWorksheet('Stock')!.getRow(2).getCell(c).value)).toEqual([null, null, null]);
  });
```

- [ ] **Step 2: Les voir échouer**

Run: `cd api && npx jest src/export/`
Expected: FAIL.

- [ ] **Step 3: Implémentation**

Dans `api/src/export/export.service.ts` :

```ts
import { ApogeeConfidence, estimateApogee } from '../apogee/apogee';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
```

```ts
const CONFIDENCE_LABEL: Record<ApogeeConfidence, string> = { SAISIE: 'Saisie', MOYENNE: 'Moyenne', FAIBLE: 'Faible' };
/** Fond d'avertissement des lignes dont l'apogée est passée. */
const PASSED_FILL = 'FFFCE4D6';
```

Constructeur :

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: ApogeeRulesService,
  ) {}
```

Charger les règles avec le reste (`const rules = await this.rules.load();` avant la construction du classeur, et `const year = new Date().getFullYear();`). Colonnes de *Stock* :

```ts
    stock.columns = [
      { header: 'Producteur', key: 'producer', width: 28 },
      { header: 'Cuvée', key: 'cuvee', width: 22 },
      { header: 'Appellation', key: 'appellation', width: 26 },
      { header: 'Région', key: 'region', width: 14 },
      { header: 'Millésime', key: 'vintage', width: 10 },
      { header: 'Apogée min', key: 'apogeeMin', width: 11 },
      { header: 'Apogée max', key: 'apogeeMax', width: 11 },
      { header: 'Confiance', key: 'confidence', width: 11 },
      { header: 'Couleur', key: 'color', width: 10 },
      { header: 'Format (cl)', key: 'formatCl', width: 10 },
      { header: 'Quantité', key: 'quantity', width: 10 },
      { header: "Prix d'achat unitaire (€)", key: 'price', width: 20 },
      { header: "Valeur d'achat (€)", key: 'value', width: 16 },
    ];
    for (const w of inStock) {
      const q = stockByWine.get(w.id) ?? 0;
      const price = lastPrice.has(w.id) ? lastPrice.get(w.id)! / 100 : null;
      // Même calcul que l'application : l'export ne raconte jamais une autre apogée.
      const apogee = estimateApogee(
        {
          vintage: w.vintage, color: w.color, appellationId: w.appellationId, region: w.appellation?.region ?? null,
          referenceGuardMin: w.appellation?.guardMinYears ?? null, referenceGuardMax: w.appellation?.guardMaxYears ?? null,
          apogeeMin: w.apogeeMin, apogeeMax: w.apogeeMax, apogeeSource: w.apogeeSource,
        },
        rules, year,
      );
      const row = stock.addRow({
        producer: w.producer, cuvee: w.cuvee ?? '', appellation: w.appellationRaw, region: w.appellation?.region ?? '',
        vintage: w.vintage ?? 'NV', apogeeMin: apogee.min, apogeeMax: apogee.max,
        confidence: apogee.confidence ? CONFIDENCE_LABEL[apogee.confidence] : null,
        color: COLOR_LABEL[w.color], formatCl: w.formatCl, quantity: q,
        price, value: price == null ? null : Math.round(price * q * 100) / 100,
      });
      if (apogee.status === 'PASSEE') {
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PASSED_FILL } };
        });
      }
    }
    stock.autoFilter = { from: 'A1', to: 'M1' };
```

Dans `api/src/export/export.module.ts`, ajouter `ApogeeModule` aux `imports`.

- [ ] **Step 4: Lancer les tests**

Run: `cd api && npx jest && npm run lint && npx tsc --noEmit -p tsconfig.build.json && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/export
git commit -m "feat(apogee): apogée et confiance dans l'export, apogées passées mises en évidence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — bloc Apogée de la fiche et mention dans la liste

**Files:**
- Modify: `web/src/lib/api-client.ts`
- Create: `web/src/lib/apogee.ts`, `web/src/lib/apogee.test.ts`
- Create: `web/src/components/ApogeeBlock.tsx`, `web/src/components/ApogeeBlock.test.tsx`
- Modify: `web/src/pages/WinePage.tsx`, `web/src/pages/CavePage.tsx`, `web/src/pages/CavePage.test.tsx`

**Interfaces:**
- Consumes: `GET /cave`, `GET /wines/:id` (champ `apogee`), `PUT`/`DELETE /wines/:id/apogee` (tâche 4).
- Produces (`api-client.ts`) : types `Apogee`, `ApogeeConfidence`, `ApogeeStatus`, `ApogeeReason` ; `CaveRow.apogee?: Apogee` ; `setApogee(wineId, { min, max }): Promise<Apogee>` ; `clearApogee(wineId): Promise<Apogee>`. (`lib/apogee.ts`) : `apogeeRange(a)`, `apogeeStatusLabel(a)`, `apogeeShortLabel(a)`, `apogeeReasonMessage(reason)`, `CONFIDENCE_LABEL`. Composant `ApogeeBlock({ wine }: { wine: CaveRow })`.

- [ ] **Step 1: Tests des libellés**

`web/src/lib/apogee.test.ts` :

```ts
import { Apogee } from './api-client';
import { apogeeRange, apogeeReasonMessage, apogeeShortLabel, apogeeStatusLabel } from './apogee';

const a = (over: Partial<Apogee>): Apogee => ({ min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE', ...over });

it('formule la fourchette', () => {
  expect(apogeeRange(a({}))).toBe('À boire entre 2024 et 2036');
  expect(apogeeRange(a({ min: 2030, max: 2030 }))).toBe('À boire en 2030');
  expect(apogeeRange(a({ min: null, max: null, status: null, reason: 'NON_MILLESIME' }))).toBeNull();
});

it.each([
  ['TROP_JEUNE', 'Trop jeune — à partir de 2024', 'Trop jeune (2024)'],
  ['A_BOIRE', 'À boire — jusqu’en 2036', 'À boire 2024-2036'],
  ['A_BOIRE_VITE', 'À boire vite — 2036 est la dernière année', 'À boire vite'],
  ['PASSEE', 'Apogée passée depuis 2036', 'Apogée passée'],
] as const)('statut %s', (status, long, short) => {
  expect(apogeeStatusLabel(a({ status }))).toBe(long);
  expect(apogeeShortLabel(a({ status }))).toBe(short);
});

it('n’a pas de libellé sans estimation', () => {
  const none = a({ min: null, max: null, confidence: null, status: null, reason: 'GARDE_INCONNUE', source: null });
  expect(apogeeStatusLabel(none)).toBeNull();
  expect(apogeeShortLabel(none)).toBeNull();
});

it('explique chaque absence d’estimation', () => {
  expect(apogeeReasonMessage('NON_MILLESIME')).toBe('Vin non millésimé : saisis la fourchette si tu la connais');
  expect(apogeeReasonMessage('APPELLATION_INCONNUE')).toBe('Appellation non reconnue par le référentiel : saisis la fourchette');
  expect(apogeeReasonMessage('GARDE_INCONNUE')).toBe('Garde inconnue pour cette appellation : saisis la fourchette');
});
```

- [ ] **Step 2: Tests du bloc**

`web/src/components/ApogeeBlock.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { ApogeeBlock } from './ApogeeBlock';

afterEach(() => vi.restoreAllMocks());

const base: api.CaveRow = {
  id: 'w1', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
  color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  apogee: { min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' },
};

function mount(wine: api.CaveRow = base) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApogeeBlock wine={wine} />
    </QueryClientProvider>,
  );
}

it('affiche la fourchette, la confiance et le statut', () => {
  mount();
  expect(screen.getByText('À boire entre 2024 et 2036')).toBeInTheDocument();
  expect(screen.getByText('Confiance faible')).toBeInTheDocument();
  expect(screen.getByText('À boire — jusqu’en 2036')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revenir à l’estimation' })).not.toBeInTheDocument();
});

it('explique l’absence d’estimation et propose la saisie', () => {
  mount({ ...base, vintage: null, apogee: { min: null, max: null, confidence: null, status: null, reason: 'NON_MILLESIME', source: null } });
  expect(screen.getByText('Vin non millésimé : saisis la fourchette si tu la connais')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Corriger' })).toBeInTheDocument();
});

it('enregistre une correction', async () => {
  const set = vi.spyOn(api, 'setApogee').mockResolvedValue({ min: 2030, max: 2035, confidence: 'SAISIE', status: 'TROP_JEUNE', reason: null, source: 'MANUEL' });
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Corriger' }));
  await userEvent.clear(screen.getByLabelText('Année de début'));
  await userEvent.type(screen.getByLabelText('Année de début'), '2030');
  await userEvent.clear(screen.getByLabelText('Année de fin'));
  await userEvent.type(screen.getByLabelText('Année de fin'), '2035');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’apogée' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith('w1', { min: 2030, max: 2035 }));
});

it('refuse une fin avant le début sans rien envoyer', async () => {
  const set = vi.spyOn(api, 'setApogee');
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Corriger' }));
  await userEvent.clear(screen.getByLabelText('Année de début'));
  await userEvent.type(screen.getByLabelText('Année de début'), '2040');
  expect(screen.getByText('L’année de début doit précéder ou égaler l’année de fin')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer l’apogée' })).toBeDisabled();
  expect(set).not.toHaveBeenCalled();
});

it('revient à l’estimation quand la fourchette est saisie', async () => {
  const clear = vi.spyOn(api, 'clearApogee').mockResolvedValue(base.apogee!);
  mount({ ...base, apogee: { min: 2030, max: 2035, confidence: 'SAISIE', status: 'TROP_JEUNE', reason: null, source: 'MANUEL' } });
  expect(screen.getByText('Saisie')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Revenir à l’estimation' }));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('w1'));
});

it('affiche en clair une erreur de l’api', async () => {
  vi.spyOn(api, 'setApogee').mockRejectedValue(new api.ApiError(400, 'Année de fin trop lointaine'));
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Corriger' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’apogée' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Année de fin trop lointaine');
});
```

Dans `web/src/pages/CavePage.test.tsx`, donner à la ligne `w1` du tableau `rows` le champ `apogee: { min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' }` et ajouter :

```tsx
it('montre une mention d’apogée sur la ligne', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  const row = await screen.findByRole('link', { name: /Domaine Tempier/ });
  expect(within(row).getByText('À boire 2024-2036')).toBeInTheDocument();
});
```

(importer `within` depuis `@testing-library/react` s'il ne l'est pas déjà).

- [ ] **Step 3: Les voir échouer**

Run: `cd web && npx vitest run src/lib/apogee.test.ts src/components/ApogeeBlock.test.tsx src/pages/CavePage.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Client d'API**

Dans `web/src/lib/api-client.ts`, avant `export interface CaveRow` :

```ts
export type ApogeeConfidence = 'SAISIE' | 'MOYENNE' | 'FAIBLE';
export type ApogeeStatus = 'TROP_JEUNE' | 'A_BOIRE' | 'A_BOIRE_VITE' | 'PASSEE';
export type ApogeeReason = 'NON_MILLESIME' | 'APPELLATION_INCONNUE' | 'GARDE_INCONNUE';
export interface Apogee {
  min: number | null; max: number | null; confidence: ApogeeConfidence | null;
  status: ApogeeStatus | null; reason: ApogeeReason | null; source: 'MANUEL' | 'REGLE' | null;
}
```

Dans `CaveRow`, ajouter :

```ts
  /** Toujours fourni par la liste et la fiche ; absent des candidats de sortie. */
  apogee?: Apogee;
```

À la fin du fichier :

```ts
export const setApogee = (wineId: string, input: { min: number; max: number }) =>
  apiFetch<Apogee>(`/wines/${wineId}/apogee`, { method: 'PUT', body: JSON.stringify(input) });
export const clearApogee = (wineId: string) => apiFetch<Apogee>(`/wines/${wineId}/apogee`, { method: 'DELETE' });
```

- [ ] **Step 5: Libellés**

`web/src/lib/apogee.ts` :

```ts
import { Apogee, ApogeeConfidence, ApogeeReason } from './api-client';

export const CONFIDENCE_LABEL: Record<ApogeeConfidence, string> = {
  SAISIE: 'Saisie', MOYENNE: 'Confiance moyenne', FAIBLE: 'Confiance faible',
};

const REASON_MESSAGE: Record<ApogeeReason, string> = {
  NON_MILLESIME: 'Vin non millésimé : saisis la fourchette si tu la connais',
  APPELLATION_INCONNUE: 'Appellation non reconnue par le référentiel : saisis la fourchette',
  GARDE_INCONNUE: 'Garde inconnue pour cette appellation : saisis la fourchette',
};

export function apogeeRange(a: Apogee): string | null {
  if (a.min == null || a.max == null) return null;
  return a.min === a.max ? `À boire en ${a.min}` : `À boire entre ${a.min} et ${a.max}`;
}

export function apogeeStatusLabel(a: Apogee): string | null {
  switch (a.status) {
    case 'TROP_JEUNE': return `Trop jeune — à partir de ${a.min}`;
    case 'A_BOIRE': return `À boire — jusqu’en ${a.max}`;
    case 'A_BOIRE_VITE': return `À boire vite — ${a.max} est la dernière année`;
    case 'PASSEE': return `Apogée passée depuis ${a.max}`;
    default: return null;
  }
}

/** Mention courte pour une ligne de la liste. */
export function apogeeShortLabel(a: Apogee): string | null {
  switch (a.status) {
    case 'TROP_JEUNE': return `Trop jeune (${a.min})`;
    case 'A_BOIRE': return `À boire ${a.min}-${a.max}`;
    case 'A_BOIRE_VITE': return 'À boire vite';
    case 'PASSEE': return 'Apogée passée';
    default: return null;
  }
}

export function apogeeReasonMessage(reason: ApogeeReason): string {
  return REASON_MESSAGE[reason];
}
```

- [ ] **Step 6: Bloc Apogée**

`web/src/components/ApogeeBlock.tsx` :

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CaveRow, clearApogee, setApogee } from '../lib/api-client';
import { apogeeRange, apogeeReasonMessage, apogeeStatusLabel, CONFIDENCE_LABEL } from '../lib/apogee';
import { Button } from './Button';

const YEAR = /^\d{4}$/;

function check(minText: string, maxText: string): { min: number; max: number } | string {
  if (!YEAR.test(minText) || !YEAR.test(maxText)) return 'Saisis deux années sur quatre chiffres';
  const min = Number(minText);
  const max = Number(maxText);
  if (min < 1900 || max > 2200) return 'Années entre 1900 et 2200';
  if (min > max) return 'L’année de début doit précéder ou égaler l’année de fin';
  return { min, max };
}

export function ApogeeBlock({ wine }: { wine: CaveRow }) {
  const qc = useQueryClient();
  const apogee = wine.apogee;
  const [editing, setEditing] = useState(false);
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!apogee) return null;

  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['cave', 'wine'].includes(String(q.queryKey[0])) });
  const verdict = check(minText, maxText);

  function open() {
    const year = new Date().getFullYear();
    setMinText(String(apogee!.min ?? year));
    setMaxText(String(apogee!.max ?? year));
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

  const range = apogeeRange(apogee);
  const status = apogeeStatusLabel(apogee);
  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Apogée</h3>
      {range ? (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>{range}</p>
          {apogee.confidence && (
            <span className={`badge ${apogee.confidence === 'FAIBLE' ? 'badge--warn' : 'badge--ok'}`}>{CONFIDENCE_LABEL[apogee.confidence]}</span>
          )}
          {status && <p className="list__meta" style={{ margin: 'var(--space-xs) 0 0' }}>{status}</p>}
        </>
      ) : (
        apogee.reason && <p className="list__meta">{apogeeReasonMessage(apogee.reason)}</p>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
          <label className="field__label" htmlFor="apogee-min">Année de début</label>
          <input id="apogee-min" inputMode="numeric" value={minText} onChange={(e) => setMinText(e.target.value.trim())} />
          <label className="field__label" htmlFor="apogee-max">Année de fin</label>
          <input id="apogee-max" inputMode="numeric" value={maxText} onChange={(e) => setMaxText(e.target.value.trim())} />
          {typeof verdict === 'string' && <p className="text-error" style={{ margin: 0 }}>{verdict}</p>}
          <Button variant="dark" disabled={busy || typeof verdict === 'string'} onClick={() => typeof verdict !== 'string' && run(() => setApogee(wine.id, verdict))}>
            Enregistrer l’apogée
          </Button>
          <Button variant="link" onClick={() => setEditing(false)}>Abandonner</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
          <Button variant="outline" onClick={open}>Corriger</Button>
          {apogee.confidence === 'SAISIE' && (
            <Button variant="link" disabled={busy} onClick={() => run(() => clearApogee(wine.id))}>Revenir à l’estimation</Button>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Câblage**

Dans `web/src/pages/WinePage.tsx`, importer `ApogeeBlock` et l'insérer juste avant `<SortieConfirmation key={wine.id} wine={wine} />` :

```tsx
        <ApogeeBlock wine={wine} />
```

Dans `web/src/pages/CavePage.tsx`, importer `apogeeShortLabel` depuis `'../lib/apogee'` et, dans la ligne, juste après le `<span className="list__meta">…</span>` de l'appellation :

```tsx
                {w.apogee && apogeeShortLabel(w.apogee) && (
                  <span className="list__meta" style={{ display: 'block' }}>{apogeeShortLabel(w.apogee)}</span>
                )}
```

- [ ] **Step 8: Lancer les tests**

Run: `cd web && npx vitest run && npm run lint && npx tsc --noEmit && npm run build`
Expected: PASS (les tests existants de la fiche et de la liste restent verts : leurs données sans `apogee` n'affichent pas de bloc).

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "feat(apogee): fourchette, confiance et correction sur la fiche, mention dans la cave

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — administration des règles

**Files:**
- Modify: `web/src/lib/api-client.ts`
- Create: `web/src/components/admin/VintagesSection.tsx`, `web/src/components/admin/VintagesSection.test.tsx`
- Create: `web/src/components/admin/GuardsSection.tsx`, `web/src/components/admin/GuardsSection.test.tsx`
- Modify: `web/src/pages/AdminPage.tsx`

**Interfaces:**
- Consumes: routes `/admin/vintages`, `/admin/guards` (tâche 3).
- Produces (`api-client.ts`) : `VintageQualityLevel`, `VintageQualityRow`, `getVintages()`, `putVintage(row)`, `deleteVintage(region, year)`, `GuardAppellation`, `searchGuards(q)`, `putGuard(input)`, `deleteGuard(id)`.

- [ ] **Step 1: Tests**

`web/src/components/admin/VintagesSection.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../lib/api-client';
import { VintagesSection } from './VintagesSection';

afterEach(() => vi.restoreAllMocks());

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VintagesSection />
    </QueryClientProvider>,
  );
}

it('liste les millésimes qualifiés', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Bordeaux', 'Rhône'], qualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] });
  mount();
  expect(await screen.findByText('Rhône 2016 — Grand')).toBeInTheDocument();
});

it('qualifie un millésime', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Bordeaux', 'Rhône'], qualities: [] });
  const put = vi.spyOn(api, 'putVintage').mockResolvedValue({ region: 'Rhône', year: 2016, quality: 'FAIBLE' });
  mount();
  await screen.findByLabelText('Région');
  await userEvent.selectOptions(screen.getByLabelText('Région'), 'Rhône');
  await userEvent.type(screen.getByLabelText('Année'), '2016');
  await userEvent.click(screen.getByRole('button', { name: 'Faible' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith({ region: 'Rhône', year: 2016, quality: 'FAIBLE' }));
});

it('n’envoie rien tant que l’année n’a pas quatre chiffres', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Rhône'], qualities: [] });
  mount();
  await screen.findByLabelText('Région');
  await userEvent.type(screen.getByLabelText('Année'), '201');
  expect(screen.getByRole('button', { name: 'Grand' })).toBeDisabled();
});

it('remet un millésime à « non qualifié »', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Languedoc-Roussillon'], qualities: [{ region: 'Languedoc-Roussillon', year: 2016, quality: 'GRAND' }] });
  const del = vi.spyOn(api, 'deleteVintage').mockResolvedValue(undefined);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Retirer Languedoc-Roussillon 2016' }));
  await waitFor(() => expect(del).toHaveBeenCalledWith('Languedoc-Roussillon', 2016));
});

it('encode une région accentuée ou à tiret dans l’adresse', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await api.deleteVintage('Rhône', 2016);
  await api.deleteVintage('Languedoc-Roussillon', 2016);
  expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/admin/vintages/Rh%C3%B4ne/2016', '/api/admin/vintages/Languedoc-Roussillon/2016']);
});
```

`web/src/components/admin/GuardsSection.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../lib/api-client';
import { GuardsSection } from './GuardsSection';

afterEach(() => vi.restoreAllMocks());

const cdp: api.GuardAppellation = {
  id: '11111111-1111-4111-8111-111111111111', canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', guardMinYears: 8, guardMaxYears: 20,
  overrides: [{ id: '22222222-2222-4222-8222-222222222222', color: 'ROSE', min: 1, max: 2 }],
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GuardsSection />
    </QueryClientProvider>,
  );
}

it('cherche une appellation et montre sa garde et ses ajustements', async () => {
  const search = vi.spyOn(api, 'searchGuards').mockResolvedValue([cdp]);
  mount();
  await userEvent.type(screen.getByLabelText('Appellation'), 'chateauneuf');
  await waitFor(() => expect(search).toHaveBeenLastCalledWith('chateauneuf'));
  expect(await screen.findByText('Garde du référentiel : 8 à 20 ans')).toBeInTheDocument();
  expect(screen.getByText('Rosé : 1 à 2 ans')).toBeInTheDocument();
});

it('ajuste la garde pour toutes les couleurs', async () => {
  vi.spyOn(api, 'searchGuards').mockResolvedValue([cdp]);
  const put = vi.spyOn(api, 'putGuard').mockResolvedValue({ id: 'o9', color: null, min: 10, max: 25 });
  mount();
  await userEvent.type(screen.getByLabelText('Appellation'), 'chateauneuf');
  await userEvent.click(await screen.findByRole('button', { name: 'Ajuster Châteauneuf-du-Pape' }));
  await userEvent.type(screen.getByLabelText('Garde minimale'), '10');
  await userEvent.type(screen.getByLabelText('Garde maximale'), '25');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la garde' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith({ appellationId: cdp.id, color: null, min: 10, max: 25 }));
});

it('refuse une garde minimale supérieure à la maximale', async () => {
  vi.spyOn(api, 'searchGuards').mockResolvedValue([cdp]);
  mount();
  await userEvent.type(screen.getByLabelText('Appellation'), 'chateauneuf');
  await userEvent.click(await screen.findByRole('button', { name: 'Ajuster Châteauneuf-du-Pape' }));
  await userEvent.type(screen.getByLabelText('Garde minimale'), '9');
  await userEvent.type(screen.getByLabelText('Garde maximale'), '3');
  expect(screen.getByRole('button', { name: 'Enregistrer la garde' })).toBeDisabled();
});

it('retire un ajustement', async () => {
  vi.spyOn(api, 'searchGuards').mockResolvedValue([cdp]);
  const del = vi.spyOn(api, 'deleteGuard').mockResolvedValue(undefined);
  mount();
  await userEvent.type(screen.getByLabelText('Appellation'), 'chateauneuf');
  await userEvent.click(await screen.findByRole('button', { name: 'Retirer l’ajustement Rosé' }));
  await waitFor(() => expect(del).toHaveBeenCalledWith(cdp.overrides[0].id));
});
```

- [ ] **Step 2: Les voir échouer**

Run: `cd web && npx vitest run src/components/admin/`
Expected: FAIL.

- [ ] **Step 3: Client d'API**

À la fin de `web/src/lib/api-client.ts` :

```ts
export type VintageQualityLevel = 'GRAND' | 'MOYEN' | 'FAIBLE';
export interface VintageQualityRow { region: string; year: number; quality: VintageQualityLevel }
export const getVintages = () => apiFetch<{ regions: string[]; qualities: VintageQualityRow[] }>('/admin/vintages');
export const putVintage = (row: VintageQualityRow) =>
  apiFetch<VintageQualityRow>('/admin/vintages', { method: 'PUT', body: JSON.stringify(row) });
/** La région peut porter un accent ou un tiret (« Rhône », « Languedoc-Roussillon ») : elle est encodée dans l'adresse. */
export const deleteVintage = (region: string, year: number) =>
  apiFetch<void>(`/admin/vintages/${encodeURIComponent(region)}/${year}`, { method: 'DELETE' });

export interface GuardAppellation {
  id: string; canonicalName: string; region: string | null; guardMinYears: number | null; guardMaxYears: number | null;
  overrides: Array<{ id: string; color: WineColor | null; min: number; max: number }>;
}
export const searchGuards = (q: string) => apiFetch<GuardAppellation[]>(`/admin/guards?q=${encodeURIComponent(q)}`);
export const putGuard = (input: { appellationId: string; color: WineColor | null; min: number; max: number }) =>
  apiFetch<{ id: string; color: WineColor | null; min: number; max: number }>('/admin/guards', { method: 'PUT', body: JSON.stringify(input) });
export const deleteGuard = (id: string) => apiFetch<void>(`/admin/guards/${id}`, { method: 'DELETE' });
```

- [ ] **Step 4: Section des millésimes**

`web/src/components/admin/VintagesSection.tsx` :

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteVintage, getVintages, putVintage, VintageQualityLevel, VintageQualityRow } from '../../lib/api-client';
import { Button } from '../Button';

const QUALITY_LABEL: Record<VintageQualityLevel, string> = { GRAND: 'Grand', MOYEN: 'Moyen', FAIBLE: 'Faible' };

/** Une qualité de millésime change les apogées de toute la région : on rafraîchit aussi la cave. */
const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => ['admin', 'cave', 'wine'].includes(String(q.queryKey[0])) });

export function VintagesSection() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'vintages'], queryFn: getVintages });
  const [region, setRegion] = useState('');
  const [yearText, setYearText] = useState('');
  // Fonctions enveloppées : la mutation reçoit exactement un argument, quelle que soit la version de TanStack Query.
  const put = useMutation({ mutationFn: (row: VintageQualityRow) => putVintage(row), onSuccess: () => invalidate(qc) });
  const del = useMutation({ mutationFn: ({ r, y }: { r: string; y: number }) => deleteVintage(r, y), onSuccess: () => invalidate(qc) });

  const regions = data.data?.regions ?? [];
  const chosenRegion = region || regions[0] || '';
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
  const error = (put.error ?? del.error) as Error | null;

  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Qualité des millésimes</h2>
      <p className="list__meta">Un millésime non qualifié vaut « moyen » et abaisse la confiance des apogées.</p>
      {data.isError && <p role="alert" className="text-error">Impossible de charger les millésimes.</p>}
      {data.data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'center' }}>
          <label htmlFor="vintage-region" className="field__label">Région</label>
          <select id="vintage-region" value={chosenRegion} onChange={(e) => setRegion(e.target.value)}>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label htmlFor="vintage-year" className="field__label">Année</label>
          <input id="vintage-year" inputMode="numeric" value={yearText} onChange={(e) => setYearText(e.target.value.trim())} style={{ width: 96 }} />
          {(Object.keys(QUALITY_LABEL) as VintageQualityLevel[]).map((q) => (
            <Button key={q} variant="outline" disabled={year === null || !chosenRegion || put.isPending}
              onClick={() => year !== null && put.mutate({ region: chosenRegion, year, quality: q })}>
              {QUALITY_LABEL[q]}
            </Button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-error">{error.message}</p>}
      <div className="list" style={{ marginTop: 'var(--space-sm)' }}>
        {data.data?.qualities.map((v) => (
          <div key={`${v.region}-${v.year}`} className="list__row">
            <span style={{ flex: 1 }}>{`${v.region} ${v.year} — ${QUALITY_LABEL[v.quality]}`}</span>
            <Button variant="link" aria-label={`Retirer ${v.region} ${v.year}`} disabled={del.isPending} onClick={() => del.mutate({ r: v.region, y: v.year })}>
              Retirer
            </Button>
          </div>
        ))}
        {data.data?.qualities.length === 0 && <p className="centered">Aucun millésime qualifié : tous valent « moyen ».</p>}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Section des gardes**

`web/src/components/admin/GuardsSection.tsx` :

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteGuard, GuardAppellation, putGuard, searchGuards, WineColor } from '../../lib/api-client';
import { Button } from '../Button';

const COLOR_LABEL: Record<WineColor, string> = { ROUGE: 'Rouge', BLANC: 'Blanc', ROSE: 'Rosé', PETILLANT: 'Pétillant' };
const colorLabel = (c: WineColor | null) => (c ? COLOR_LABEL[c] : 'Toutes couleurs');
const years = (min: number | null, max: number | null) => (min == null || max == null ? 'inconnue' : `${min} à ${max} ans`);

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => ['admin', 'cave', 'wine'].includes(String(q.queryKey[0])) });

export function GuardsSection() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<GuardAppellation | null>(null);
  const [color, setColor] = useState<WineColor | ''>('');
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const results = useQuery({ queryKey: ['admin', 'guards', q], queryFn: () => searchGuards(q), enabled: q.trim().length >= 2 });
  const put = useMutation({
    mutationFn: (input: { appellationId: string; color: WineColor | null; min: number; max: number }) => putGuard(input),
    onSuccess: () => { setSelected(null); void invalidate(qc); },
  });
  const del = useMutation({ mutationFn: (id: string) => deleteGuard(id), onSuccess: () => invalidate(qc) });

  const min = /^\d{1,3}$/.test(minText) ? Number(minText) : null;
  const max = /^\d{1,3}$/.test(maxText) ? Number(maxText) : null;
  const valid = min !== null && max !== null && min <= max && max <= 100;
  const error = (put.error ?? del.error) as Error | null;

  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Gardes</h2>
      <label htmlFor="guard-search" className="field__label">Appellation</label>
      <input id="guard-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Au moins deux lettres" />
      {error && <p role="alert" className="text-error">{error.message}</p>}
      <div className="list" style={{ marginTop: 'var(--space-sm)' }}>
        {results.data?.map((a) => (
          <div key={a.id} className="list__row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <strong>{a.canonicalName}</strong>
            <span className="list__meta">Garde du référentiel : {years(a.guardMinYears, a.guardMaxYears)}</span>
            {a.overrides.map((o) => (
              <span key={o.id} className="list__meta" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                {/* Texte dans son propre élément, séparé du bouton : il reste lisible et retrouvable seul. */}
                <span>{`${colorLabel(o.color)} : ${years(o.min, o.max)}`}</span>
                <Button variant="link" aria-label={`Retirer l’ajustement ${colorLabel(o.color)}`} disabled={del.isPending} onClick={() => del.mutate(o.id)}>
                  Retirer
                </Button>
              </span>
            ))}
            <Button variant="outline" aria-label={`Ajuster ${a.canonicalName}`} onClick={() => { setSelected(a); setColor(''); setMinText(''); setMaxText(''); }}>
              Ajuster
            </Button>
            {selected?.id === a.id && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'center' }}>
                <label htmlFor="guard-color" className="field__label">Couleur</label>
                <select id="guard-color" value={color} onChange={(e) => setColor(e.target.value as WineColor | '')}>
                  <option value="">Toutes couleurs</option>
                  {(Object.keys(COLOR_LABEL) as WineColor[]).map((c) => <option key={c} value={c}>{COLOR_LABEL[c]}</option>)}
                </select>
                <label htmlFor="guard-min" className="field__label">Garde minimale</label>
                <input id="guard-min" inputMode="numeric" value={minText} onChange={(e) => setMinText(e.target.value.trim())} style={{ width: 72 }} />
                <label htmlFor="guard-max" className="field__label">Garde maximale</label>
                <input id="guard-max" inputMode="numeric" value={maxText} onChange={(e) => setMaxText(e.target.value.trim())} style={{ width: 72 }} />
                <Button variant="dark" disabled={!valid || put.isPending}
                  onClick={() => valid && put.mutate({ appellationId: a.id, color: color || null, min: min!, max: max! })}>
                  Enregistrer la garde
                </Button>
              </div>
            )}
          </div>
        ))}
        {results.data?.length === 0 && <p className="centered">Aucune appellation ne correspond.</p>}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Câblage**

Dans `web/src/pages/AdminPage.tsx`, importer les deux sections et les ajouter dans le bloc `{me.data?.isAdmin && (<> … </>)}`, après la `<div className="list">` des comptes :

```tsx
            <VintagesSection />
            <GuardsSection />
```

- [ ] **Step 7: Lancer les tests**

Run: `cd web && npx vitest run && npm run lint && npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(apogee): administrer la qualité des millésimes et les gardes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Vérification dans le navigateur, documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Suites complètes**

Run: `cd api && npx jest && DATABASE_URL=postgresql://postgres:dev@localhost:5432/cave_test REDIS_URL=redis://localhost:6379 npx jest && npm run lint && npm run build && cd ../web && npx vitest run && npm run lint && npm run build`
Expected: tout vert.

- [ ] **Step 2: Essai dans le navigateur (375 px)**

API sur `cave_test` avec le compte de secours (administrateur), web en développement. Vérifier : la fiche d'un vin avec appellation reconnue (fourchette, confiance faible, statut) ; *Corriger* puis *Revenir à l'estimation* ; un vin non millésimé (message) ; dans l'administration, qualifier le millésime d'une région puis constater la fourchette changée sur la fiche ; ajuster une garde puis la retirer ; la mention dans l'onglet Cave ; l'export (colonnes d'apogée).

- [ ] **Step 3: README**

Dans `README.md` :
- en-tête « État » : `lot 0, lot 1, lot 2a et lot 2b livrés`, l'apogée dans la liste ; « À venir » ne cite plus que la cote iDealwine (lot 2c) ;
- « Fonctionnalités » : paragraphe **Apogée** après « La cave et la sortie » — estimation par règles (garde de l'appellation, rosé 1-3 ans, ajustements par appellation et par couleur, qualité du millésime « moyen » par défaut), fourchette, confiance, statut, correction par vin qui prime, règles réservées aux administrateurs ;
- « Export Excel » : colonnes *Apogée min*, *Apogée max*, *Confiance*, mise en évidence des apogées passées ;
- « Limites » : la qualité des millésimes n'est pas pré-remplie (tout vaut « moyen » jusqu'à qualification) ; pas d'estimation pour les non millésimés ; vue « à boire cette année » et alertes : lot 3 ;
- section Développement : ajouter les deux index partiels de `guard_override` à la phrase sur le SQL écrit à la main ;
- « Journal des modifications » : `### Non publié` en tête avec le résumé du lot.

- [ ] **Step 4: CHANGELOG**

`## Non publié` sous l'introduction, avec `### Résumé`, `### Fonctionnalités` (une puce par capacité livrée).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: lot 2b — l'apogée

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
