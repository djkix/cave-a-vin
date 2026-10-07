import { PrismaClient } from '@prisma/client';
import { EntryBatchProcessor } from './entry-batch.processor';
import { CaveBudgetShareExceededError } from './vision-budget.service';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';

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
  let caveId: string;
  let otherCaveId: string;

  beforeAll(async () => {
    caveId = (await createTestCave(prisma)).id;
    otherCaveId = (await createTestCave(prisma)).id;
  });
  const photoIds: string[] = [];
  const reads: string[] = [];
  /** Photos envoyées à Gemini, appel par appel (lot ou photo seule). */
  const calls: string[][] = [];
  const photos = {
    readNormalized: async (id: string) => {
      reads.push(id);
      return Buffer.from(id);
    },
  };
  const vision = {
    extractWineLabels: async (images: Array<{ data: Buffer; mimeType: string }>) => {
      calls.push(images.map((img) => img.data.toString()));
      // Laisse à l'autre passage le temps de tenter sa réservation pendant l'appel.
      await new Promise((r) => setTimeout(r, 200));
      return {
        items: images.map((img) => ({ raw: { lu: img.data.toString() }, extraction: {} as never })),
        model: 'faux',
        latencyMs: 200,
        costCents: 8,
      };
    },
    // Une photo seule (ou un reste de lot de 1 entre deux passages) passe par l'appel simple.
    extractWineLabel: async (data: Buffer) => {
      calls.push([data.toString()]);
      await new Promise((r) => setTimeout(r, 200));
      return { raw: { lu: data.toString() }, extraction: {} as never, model: 'faux', latencyMs: 200, costCents: 1 };
    },
  };
  /** Caves dont la part mensuelle est atteinte, pour le test de report. */
  const overShare = new Set<string>();
  const budget = {
    assertUnderCap: async () => undefined,
    assertCaveUnderShare: async (id: string) => {
      if (overShare.has(id)) throw new CaveBudgetShareExceededError();
    },
  };
  const processor = new EntryBatchProcessor(prisma as never, photos as never, vision as never, budget as never);

  async function photo(data: {
    createdAt: Date;
    nextAttemptAt?: Date | null;
    dismissedAt?: Date | null;
    status?: 'PENDING' | 'PROCESSING';
    caveId?: string;
  }) {
    const p = await prisma.photo.create({ data: { caveId, contentHash: key('lot'), storagePath: 'normalized/x.jpg', purpose: 'ENTRY', ...data } });
    photoIds.push(p.id);
    return p;
  }

  beforeEach(() => {
    reads.length = 0;
    calls.length = 0;
    overShare.clear();
  });

  /** Cave de chaque photo lue (y compris celles d'autres suites qui passeraient dans un lot). */
  async function cavesOf(ids: string[]): Promise<Map<string, string>> {
    const rows = await prisma.photo.findMany({ where: { id: { in: ids } }, select: { id: true, caveId: true } });
    return new Map(rows.map((r) => [r.id, r.caveId]));
  }

  afterEach(async () => {
    await prisma.photo.deleteMany({ where: { id: { in: photoIds } } });
    photoIds.length = 0;
  });

  afterAll(async () => {
    await deleteTestCaves(prisma, [caveId, otherCaveId]);
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

  it('photos de deux caves prêtes ensemble : chaque lot ne contient qu’une cave, la plus ancienne d’abord', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      // A, B, A, B, A, B : les deux caves sont entrelacées dans l'ordre d'arrivée.
      const p = await photo({ createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)), caveId: i % 2 === 0 ? caveId : otherCaveId });
      ids.push(p.id);
    }

    // Deux passages simultanés, puis de quoi vider la file.
    await Promise.all([processor.tick(), processor.tick()]);
    for (let i = 0; i < 3; i++) await processor.tick();

    const mineCalls = calls.filter((c) => c.some((id) => ids.includes(id)));
    expect(mineCalls.length).toBeGreaterThanOrEqual(2);
    const caveOf = await cavesOf(calls.flat());
    for (const call of calls) expect(new Set(call.map((id) => caveOf.get(id))).size).toBe(1);
    // Le premier lot est celui de la cave de la plus ancienne candidate.
    expect(mineCalls[0].every((id) => caveOf.get(id) === caveId)).toBe(true);
    // Chaque photo lue une seule fois, et toutes lues.
    const mine = reads.filter((id) => ids.includes(id));
    expect(mine.sort()).toEqual([...ids].sort());
    const after = await prisma.photo.findMany({ where: { id: { in: ids } } });
    after.forEach((p) => expect(p.status).toBe('DONE'));
  });

  it('cave à court de part : son lot est reporté, l’autre cave est lue dans le même passage', async () => {
    const starving: string[] = [];
    const other: string[] = [];
    for (let i = 0; i < 4; i++) {
      starving.push((await photo({ createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)), caveId })).id);
    }
    for (let i = 0; i < 3; i++) {
      other.push((await photo({ createdAt: new Date(Date.UTC(2000, 0, 1, 0, 1, i)), caveId: otherCaveId })).id);
    }
    overShare.add(caveId);

    const now = new Date();
    await processor.tick(now);

    // Aucune photo de la cave à court n'est partie chez Gemini…
    expect(reads.filter((id) => starving.includes(id))).toEqual([]);
    const s = await prisma.photo.findMany({ where: { id: { in: starving } } });
    s.forEach((p) => {
      expect(p.status).toBe('PENDING');
      expect(p.attempts).toBe(1);
      expect(p.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
      expect(p.errorMessage).toBe('Part mensuelle de cette cave atteinte — reprise le mois prochain');
    });
    // … et l'autre cave n'a pas attendu.
    expect(reads.filter((id) => other.includes(id)).sort()).toEqual([...other].sort());
    const o = await prisma.photo.findMany({ where: { id: { in: other } } });
    o.forEach((p) => expect(p.status).toBe('DONE'));
  });
});
