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
