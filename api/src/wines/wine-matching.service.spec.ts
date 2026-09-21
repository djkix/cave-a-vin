import { WineMatchingService } from './wine-matching.service';

function fakes() {
  const wines: any[] = [];
  const prisma = {
    wine: {
      findUnique: async ({ where }: any) => wines.find((w) => w.matchKey === where.matchKey) ?? null,
      create: async ({ data }: any) => {
        const w = { id: `w${wines.length + 1}`, ...data };
        wines.push(w);
        return w;
      },
    },
  };
  const appellations = {
    resolve: async (raw: string) =>
      raw.toLowerCase().includes('bandol')
        ? { kind: 'exact' as const, id: 'ap-bandol', canonicalName: 'Bandol', similarity: 0.95 }
        : { kind: 'none' as const, raw },
  };
  return { prisma, appellations, wines };
}

describe('WineMatchingService.matchOrCreate', () => {
  const draft = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'bandol aoc', vintage: 2019, color: 'ROUGE' as const, formatCl: 75 };

  it('creates a wine with the canonical appellation on first sight', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate(draft);
    expect(r.created).toBe(true);
    expect(r.wine.appellationId).toBe('ap-bandol');
    expect(r.wine.appellationRaw).toBe('Bandol');
  });

  it('returns the same wine for the same key on second sight', async () => {
    const f = fakes();
    const s = new WineMatchingService(f.prisma as any, f.appellations as any);
    const first = await s.matchOrCreate(draft);
    const second = await s.matchOrCreate({ ...draft, producer: 'TEMPIER' });
    expect(second.created).toBe(false);
    expect(second.wine.id).toBe(first.wine.id);
  });

  it('keeps the raw appellation when nothing matches', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate({ ...draft, appellationRaw: 'Vin de France' });
    expect(r.wine.appellationId).toBeNull();
    expect(r.wine.appellationRaw).toBe('Vin de France');
  });
});
