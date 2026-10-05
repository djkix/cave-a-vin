import { Prisma } from '@prisma/client';
import { ReadingQualityService } from './reading-quality.service';

describe('ReadingQualityService', () => {
  it('mesure les entrées par photo des 90 derniers jours', async () => {
    const findMany = jest.fn(async () => [
      { confirmedWine: { producer: 'X', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75 }, photo: { rawExtraction: null } },
    ]);
    const s = new ReadingQualityService({ movement: { findMany } } as any);
    const r = await s.compute(new Date('2026-10-05T00:00:00Z'));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { type: 'IN', occurredAt: { gte: new Date('2026-07-07T00:00:00Z') }, confirmedWine: { not: Prisma.DbNull } },
    }));
    expect(r).toMatchObject({ days: 90, entries: 1, rate: 3 / 6 });
  });

  it('compare à un formulaire vide une entrée confirmée avant la fin de l’analyse', async () => {
    const rawExtraction = {
      producteur: { value: 'X', confidence: 0.9 }, cuvee: { value: null, confidence: 0 }, appellation: { value: 'Bandol', confidence: 0.9 },
      millesime: { value: 2019, confidence: 0.9 }, couleur: { value: 'rouge', confidence: 0.9 }, format_cl: { value: 75, confidence: 0.9 },
      degre: { value: null, confidence: 0 }, pays_region: { value: null, confidence: 0 }, nb_cols_carton: { value: null, confidence: 0 }, confiance_globale: 0.9,
    };
    const wine = { producer: 'X', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75 };
    const findMany = jest.fn(async () => [
      { confirmedWine: { ...wine, readingShown: true }, photo: { rawExtraction } },
      { confirmedWine: { ...wine, readingShown: false }, photo: { rawExtraction } },
    ]);
    const r = await new ReadingQualityService({ movement: { findMany } } as any).compute(new Date('2026-10-05T00:00:00Z'));
    expect(r).toMatchObject({ entries: 2, rate: 3 / 12 });
  });
});
