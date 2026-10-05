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
});
