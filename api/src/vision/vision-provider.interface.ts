import { WineColor } from '@prisma/client';

export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
}

/** Cadre de l'étiquette sur la photo : [ymin, xmin, ymax, xmax], coordonnées normalisées de 0 à 1000 (convention Gemini). */
export type LabelBox = [number, number, number, number];

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
  /** `null` si le modèle n'a pas repéré l'étiquette, ou pour une lecture antérieure à ce champ. */
  labelBox: LabelBox | null;
}

export interface VisionResult {
  extraction: WineExtraction;
  raw: unknown;
  model: string;
  latencyMs: number;
  costCents: number;
}

export interface BatchVisionResult {
  items: Array<{ raw: unknown; extraction: WineExtraction } | { error: string }>;
  model: string;
  latencyMs: number;
  costCents: number;
}

/** Photo lue seule : entrée (relue hors lot) ou sortie. Par défaut, sortie. */
export type LabelPurpose = 'ENTRY' | 'EXIT';

export interface VisionProvider {
  extractWineLabel(image: Buffer, mimeType: string, purpose?: LabelPurpose): Promise<VisionResult>;
  extractWineLabels(images: Array<{ data: Buffer; mimeType: string }>): Promise<BatchVisionResult>;
}

export const VISION_PROVIDER = 'VISION_PROVIDER';
