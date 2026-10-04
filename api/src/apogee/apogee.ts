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
