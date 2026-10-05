import { compileApogeeRules } from '../apogee/apogee';
import { StatsService } from './stats.service';

describe('StatsService', () => {
  it('passe au calcul les vins avec région et apogée estimée, et tout le journal', async () => {
    const row = {
      id: 'w1', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
      color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
      appellationId: 'a-cdp', region: 'Rhône', referenceGuardMin: 8, referenceGuardMax: 20, apogeeMin: null, apogeeMax: null, apogeeSource: null,
      rating: 17,
    };
    const findMany = jest.fn(async () => [
      { id: 'm1', wineId: 'w1', delta: 2, type: 'IN', occurredAt: new Date('2026-09-01T10:00:00Z'), priceUnitCents: 3000, reversesId: null },
    ]);
    const s = new StatsService(
      { movement: { findMany } } as any,
      { allWithStock: async () => [row] } as any,
      { load: async () => compileApogeeRules({ guardOverrides: [], vintageQualities: [] }) } as any,
    );
    const stats = await s.compute(new Date('2026-10-15T12:00:00Z'));
    expect(stats).toMatchObject({ bottles: 2, purchaseValueCents: 6000 });
    expect(stats.byRegion).toEqual([{ key: 'Rhône', bottles: 2, share: 1 }]);
    expect(stats.byApogee.find((a) => a.key === 'A_BOIRE')?.bottles).toBe(2);
    expect(stats.bestRated).toEqual([{ id: 'w1', producer: 'Château de Beaucastel', cuvee: null, vintage: 2016, value: 17 }]);
    expect(findMany).toHaveBeenCalledWith({
      select: { id: true, wineId: true, delta: true, type: true, occurredAt: true, priceUnitCents: true, reversesId: true },
    });
  });
});
