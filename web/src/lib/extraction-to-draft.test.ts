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
