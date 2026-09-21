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
