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
  // Facultatif : les lectures enregistrées avant ce champ restent valides. Un
  // cadre mal formé vaut null plutôt que de rendre toute la lecture illisible —
  // il ne sert qu'à recadrer la vignette, jamais à la fiche du vin.
  etiquette: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional().catch(null),
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
  "confiance_globale": 0..1,
  "etiquette":      [ymin, xmin, ymax, xmax] (entiers 0..1000) | null
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
    labelBox: r.etiquette ?? null,
  };
}

/**
 * Même lecture que `parseExtraction`, mais jamais levée : utilisée partout où
 * une extraction illisible ne doit pas faire tomber la liste qui la contient
 * (revue groupée, écran « à confirmer »), seulement cette fiche.
 */
export function safeParseExtraction(raw: unknown): WineExtraction | null {
  if (!raw) return null;
  try {
    return parseExtraction(raw);
  } catch {
    return null;
  }
}
