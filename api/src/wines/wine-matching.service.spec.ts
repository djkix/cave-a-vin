import { Prisma } from '@prisma/client';
import { WineMatchingService } from './wine-matching.service';

function fakes() {
  const wines: any[] = [];
  const prisma = {
    wine: {
      findUnique: async ({ where }: any) =>
        wines.find((w) => w.caveId === where.caveId_matchKey.caveId && w.matchKey === where.caveId_matchKey.matchKey) ?? null,
      create: async ({ data }: any) => {
        const w = { id: `w${wines.length + 1}`, ...data };
        wines.push(w);
        return w;
      },
    },
  };
  const appellations = {
    resolve: async (raw: string) => {
      const needle = raw.toLowerCase();
      if (needle.includes('bandol')) return { kind: 'exact' as const, id: 'ap-bandol', canonicalName: 'Bandol', similarity: 0.95 };
      if (needle.includes('chateauneuf')) return { kind: 'fuzzy' as const, id: 'ap-cdp', canonicalName: 'Châteauneuf-du-Pape', similarity: 0.6 };
      return { kind: 'none' as const, raw };
    },
  };
  return { prisma, appellations, wines };
}

describe('WineMatchingService.matchOrCreate', () => {
  const draft = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'bandol aoc', vintage: 2019, color: 'ROUGE' as const, formatCl: 75 };

  it('creates a wine with the canonical appellation on first sight', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate('c1', draft);
    expect(r.created).toBe(true);
    expect(r.wine.appellationId).toBe('ap-bandol');
    expect(r.wine.appellationRaw).toBe('Bandol');
    expect(r.wine.caveId).toBe('c1');
  });

  it('rapproche dans la cave seulement : le même vin dans une autre cave est une autre fiche', async () => {
    const f = fakes();
    const s = new WineMatchingService(f.prisma as any, f.appellations as any);
    const a = await s.matchOrCreate('cave-a', draft);
    const b = await s.matchOrCreate('cave-b', draft);
    expect(b.created).toBe(true);
    expect(b.wine.id).not.toBe(a.wine.id);
    expect([a.wine.caveId, b.wine.caveId]).toEqual(['cave-a', 'cave-b']);
    expect((await s.matchOrCreate('cave-a', draft)).wine.id).toBe(a.wine.id);
  });

  it('returns the same wine for the same key on second sight', async () => {
    const f = fakes();
    const s = new WineMatchingService(f.prisma as any, f.appellations as any);
    const first = await s.matchOrCreate('c1', draft);
    const second = await s.matchOrCreate('c1', { ...draft, producer: 'TEMPIER' });
    expect(second.created).toBe(false);
    expect(second.wine.id).toBe(first.wine.id);
  });

  it('links a fuzzy match to the appellation without rewriting the label', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate('c1', { ...draft, appellationRaw: 'Chateauneuf' });
    expect(r.wine.appellationId).toBe('ap-cdp');
    expect(r.wine.appellationRaw).toBe('Chateauneuf');
  });

  it('keeps the raw appellation when nothing matches', async () => {
    const f = fakes();
    const r = await new WineMatchingService(f.prisma as any, f.appellations as any).matchOrCreate('c1', { ...draft, appellationRaw: 'Vin de France' });
    expect(r.wine.appellationId).toBeNull();
    expect(r.wine.appellationRaw).toBe('Vin de France');
  });

  it('recovers from a concurrent-create unique violation by returning the winning row', async () => {
    const f = fakes();
    const existingWine = { id: 'w-race', matchKey: 'placeholder' };
    let findUniqueCalls = 0;
    let createCalls = 0;
    const prisma = {
      wine: {
        findUnique: async ({ where }: any) => {
          findUniqueCalls += 1;
          if (findUniqueCalls === 1) return null;
          existingWine.matchKey = where.caveId_matchKey.matchKey;
          return existingWine;
        },
        create: async () => {
          createCalls += 1;
          throw Object.assign(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }), {});
        },
      },
    };
    const r = await new WineMatchingService(prisma as any, f.appellations as any).matchOrCreate('c1', draft);
    expect(r.created).toBe(false);
    expect(r.wine.id).toBe('w-race');
    expect(createCalls).toBe(1);
  });
});
