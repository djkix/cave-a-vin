import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { producerKeyOf } from '../producers/producer-key';
import { ProducerBatchProcessor } from '../producers/producer-batch.processor';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';
import { PairingBatchProcessor } from './pairing-batch.processor';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Lots d'accords et de descriptifs sur la vraie base : `FOR UPDATE SKIP
 * LOCKED`, comparaisons de dates du SQL brut et réservations ne se vérifient
 * pas avec un faux Prisma. Les demandes du test sont datées de l'an 2000 et
 * chaque passage reçoit une horloge de l'an 2000 : les demandes des autres
 * suites (datées d'aujourd'hui) ne sont jamais prêtes pour lui.
 */
const T0 = Date.UTC(2000, 0, 1, 0, 0, 0);
const at = (ms: number) => new Date(T0 + ms);
const SEC = 1000;
const MIN = 60_000;
const idle = { currentPause: async () => null };
const noBudgetLimit = { assertUnderShare: async () => undefined };
const slow = () => new Promise((r) => setTimeout(r, 200));

describeIfDb('accords par lots (base réelle)', () => {
  const prisma = new PrismaClient();
  let caveId: string;
  /** Producteurs envoyés à Gemini, appel par appel. */
  const calls: string[][] = [];
  const provider = {
    suggestPairingsBatch: async (wines: Array<{ producer: string }>) => {
      calls.push(wines.map((w) => w.producer));
      await slow(); // laisse à un passage concurrent le temps de tenter sa réservation
      return { items: wines.map((w, index) => ({ index, dishes: [`Plat de ${w.producer}`] })), model: 'faux', costCents: 0 };
    },
  };
  const processor = new PairingBatchProcessor(prisma as never, provider, noBudgetLimit as never, idle as never);

  beforeAll(async () => {
    caveId = (await createTestCave(prisma)).id;
  });

  afterEach(async () => {
    await prisma.pairing.deleteMany({ where: { wine: { caveId } } });
    await prisma.wine.deleteMany({ where: { caveId } });
    calls.length = 0;
  });

  afterAll(async () => {
    await deleteTestCaves(prisma, [caveId]);
    await prisma.$disconnect();
  });

  /** `n` vins en attente d'accords, demandés à T0, T0 + 1 s, … */
  async function pending(n: number): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const producer = `Lot ${randomUUID()}`;
      await prisma.wine.create({
        data: { caveId, matchKey: producer, producer, appellationRaw: 'Bandol', color: 'ROUGE', pairing: { create: { requestedAt: at(i * SEC) } } },
      });
      names.push(producer);
    }
    return names;
  }

  it('12 en attente : le premier passage en prend 10 en un appel, les 2 autres attendent 2 min puis partent', async () => {
    const names = await pending(12);

    expect(await processor.tick(at(MIN))).toEqual({ processed: 10 });
    expect(calls).toEqual([names.slice(0, 10)]);

    // 1 min 50 après la onzième demande : moins de 2 min, rien ne part.
    expect(await processor.tick(at(10 * SEC + 110 * SEC))).toEqual({ processed: 0 });
    expect(calls).toHaveLength(1);

    expect(await processor.tick(at(10 * SEC + 2 * MIN))).toEqual({ processed: 2 });
    expect(calls).toEqual([names.slice(0, 10), names.slice(10)]);

    const rows = await prisma.pairing.findMany({ where: { wine: { caveId } }, include: { wine: true } });
    expect(rows).toHaveLength(12);
    rows.forEach((r) => expect(r).toMatchObject({ status: 'DONE', dishes: [`Plat de ${r.wine.producer}`], attempts: 0, reservedUntil: null }));
  });

  it('deux passages simultanés ne prennent jamais la même demande', async () => {
    const names = await pending(15);
    const [a, b] = await Promise.all([processor.tick(at(5 * MIN)), processor.tick(at(5 * MIN))]);
    const sent = calls.flat();
    expect(sent.sort()).toEqual([...names].sort());
    expect(new Set(sent).size).toBe(15);
    expect(a.processed + b.processed).toBe(15);
    expect(await prisma.pairing.count({ where: { wine: { caveId }, status: 'DONE' } })).toBe(15);
  });

  it('une réservation échue est reprise et générée ; une réservation valide est laissée', async () => {
    await pending(2);
    const [first, second] = await prisma.pairing.findMany({ where: { wine: { caveId } }, orderBy: { requestedAt: 'asc' } });
    await prisma.pairing.update({ where: { id: first.id }, data: { reservedUntil: at(MIN) } });
    await prisma.pairing.update({ where: { id: second.id }, data: { reservedUntil: at(60 * MIN) } });
    await processor.tick(at(3 * MIN));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(await prisma.pairing.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'DONE' });
    expect(await prisma.pairing.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'PENDING', reservedUntil: at(60 * MIN), attempts: 0 });
  });
});

describeIfDb('descriptifs par lots (base réelle)', () => {
  const prisma = new PrismaClient();
  let caveId: string;
  const keys: string[] = [];
  const calls: string[][] = [];
  const provider = {
    describeProducersBatch: async (queries: Array<{ producer: string }>) => {
      calls.push(queries.map((q) => q.producer));
      await slow();
      return { items: queries.map((_, index) => ({ index, known: false, description: null })), model: 'faux', costCents: 0 };
    },
  };
  const processor = new ProducerBatchProcessor(prisma as never, provider, noBudgetLimit as never, idle as never);

  beforeAll(async () => {
    caveId = (await createTestCave(prisma)).id;
  });

  afterEach(async () => {
    await prisma.producerProfile.deleteMany({ where: { producerKey: { in: keys } } });
    await prisma.wine.deleteMany({ where: { caveId } });
    keys.length = 0;
    calls.length = 0;
  });

  afterAll(async () => {
    await deleteTestCaves(prisma, [caveId]);
    await prisma.$disconnect();
  });

  async function pending(n: number): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const producer = `Domaine Lot ${randomUUID()}`;
      await prisma.wine.create({ data: { caveId, matchKey: producer, producer, appellationRaw: 'Bandol', color: 'ROUGE' } });
      const producerKey = producerKeyOf(producer);
      keys.push(producerKey);
      await prisma.producerProfile.create({ data: { producerKey, displayName: producer, requestedAt: at(i * SEC) } });
      names.push(producer);
    }
    return names;
  }

  it('12 en attente : 10 en un appel, puis les 2 autres après 2 min', async () => {
    const names = await pending(12);
    expect(await processor.tick(at(MIN))).toEqual({ processed: 10 });
    expect(calls).toEqual([names.slice(0, 10)]);
    expect(await processor.tick(at(10 * SEC + 110 * SEC))).toEqual({ processed: 0 });
    expect(await processor.tick(at(10 * SEC + 2 * MIN))).toEqual({ processed: 2 });
    expect(calls).toEqual([names.slice(0, 10), names.slice(10)]);
    expect(await prisma.producerProfile.count({ where: { producerKey: { in: keys }, status: 'UNKNOWN', reservedUntil: null } })).toBe(12);
  });

  it('deux passages simultanés ne prennent jamais le même domaine', async () => {
    const names = await pending(15);
    await Promise.all([processor.tick(at(5 * MIN)), processor.tick(at(5 * MIN))]);
    const sent = calls.flat();
    expect(sent.sort()).toEqual([...names].sort());
    expect(new Set(sent).size).toBe(15);
  });

  it('ne prend jamais un descriptif saisi à la main', async () => {
    await pending(1);
    await prisma.producerProfile.update({ where: { producerKey: keys[0] }, data: { source: 'MANUEL' } });
    expect(await processor.tick(at(5 * MIN))).toEqual({ processed: 0 });
    expect(calls).toEqual([]);
  });
});
