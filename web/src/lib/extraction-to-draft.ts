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
