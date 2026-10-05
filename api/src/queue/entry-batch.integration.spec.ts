import { PrismaClient } from '@prisma/client';
import { EntryBatchProcessor } from './entry-batch.processor';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

/**
 * Réservation exclusive sur la vraie base : `FOR UPDATE SKIP LOCKED` et les
 * comparaisons de dates du SQL brut ne se vérifient pas avec un faux Prisma.
 * Les photos du test sont datées de l'an 2000 : ce sont les plus anciennes
 * candidates, donc celles que les passages réservent en premier.
 */
describeIfDb('analyse par lot — réservation (base réelle)', () => {
  const prisma = new PrismaClient();
  const photoIds: string[] = [];
  const reads: string[] = [];
  const photos = {
    readNormalized: async (id: string) => {
      reads.push(id);
      return Buffer.from(id);
    },
  };
  const vision = {
    extractWineLabels: async (images: Array<{ data: Buffer; mimeType: string }>) => {
      // Laisse à l'autre passage le temps de tenter sa réservation pendant l'appel.
      await new Promise((r) => setTimeout(r, 200));
      return {
        items: images.map((img) => ({ raw: { lu: img.data.toString() }, extraction: {} as never })),
        model: 'faux',
        latencyMs: 200,
        costCents: 8,
      };
    },
    extractWineLabel: async () => {
      throw new Error('relecture unitaire inattendue');
    },
  };
  const budget = { assertUnderCap: async () => undefined };
  const processor = new EntryBatchProcessor(prisma as never, photos as never, vision as never, budget as never);

  async function photo(data: { createdAt: Date; nextAttemptAt?: Date | null; dismissedAt?: Date | null; status?: 'PENDING' | 'PROCESSING' }) {
    const p = await prisma.photo.create({ data: { contentHash: key('lot'), storagePath: 'normalized/x.jpg', purpose: 'ENTRY', ...data } });
    photoIds.push(p.id);
    return p;
  }

  beforeEach(() => {
    reads.length = 0;
  });

  afterEach(async () => {
    await prisma.photo.deleteMany({ where: { id: { in: photoIds } } });
    photoIds.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deux passages simultanés : chaque photo est analysée une seule fois', async () => {
    const created = [];
    for (let i = 0; i < 8; i++) created.push(await photo({ createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)) }));
    const ids = created.map((p) => p.id);

    const [a, b] = await Promise.all([processor.tick(), processor.tick()]);

    const mine = reads.filter((id) => ids.includes(id));
    expect(mine.sort()).toEqual([...ids].sort());
    expect(new Set(mine).size).toBe(8);
    expect(a.processed + b.processed).toBeGreaterThanOrEqual(8);
    const after = await prisma.photo.findMany({ where: { id: { in: ids } } });
    after.forEach((p) => {
      expect(p.status).toBe('DONE');
      expect(p.rawExtraction).toEqual({ lu: p.id });
      expect(p.costCents).toBe(1);
      expect(p.nextAttemptAt).toBeNull();
    });
  });

  it('compare les échéances en heure exacte, quel que soit le fuseau de la base', async () => {
    const now = new Date();
    const due = await photo({ createdAt: new Date(Date.UTC(2000, 0, 1)), nextAttemptAt: new Date(now.getTime() - 60_000) });
    const later = await photo({ createdAt: new Date(Date.UTC(2000, 0, 1)), nextAttemptAt: new Date(now.getTime() + 60_000) });
    const dismissed = await photo({ createdAt: new Date(Date.UTC(2000, 0, 1)), dismissedAt: new Date(Date.UTC(2000, 0, 2)) });

    await processor.tick(now);

    expect(reads).toContain(due.id);
    expect(reads).not.toContain(later.id);
    expect(reads).not.toContain(dismissed.id);
    expect((await prisma.photo.findUniqueOrThrow({ where: { id: due.id } })).status).toBe('DONE');
    expect((await prisma.photo.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('PENDING');
  });

  it('reprend une réservation échue, pas une réservation en cours', async () => {
    const now = new Date();
    const stale = await photo({ createdAt: new Date(), status: 'PROCESSING', nextAttemptAt: new Date(now.getTime() - 1_000) });
    const live = await photo({ createdAt: new Date(), status: 'PROCESSING', nextAttemptAt: new Date(now.getTime() + 60_000) });

    await processor.tick(now);

    const s = await prisma.photo.findUniqueOrThrow({ where: { id: stale.id } });
    expect(s.status).toBe('PENDING');
    expect(s.attempts).toBe(1);
    expect((await prisma.photo.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('PROCESSING');
  });

  it('reprend une photo ENTRY PROCESSING sans échéance (ancien travail interrompu)', async () => {
    const orphan = await photo({ createdAt: new Date(), status: 'PROCESSING', nextAttemptAt: null });

    await processor.tick();

    const o = await prisma.photo.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(o.status).toBe('PENDING');
    expect(o.attempts).toBe(1);
    expect(o.nextAttemptAt).toBeNull();
  });
});
