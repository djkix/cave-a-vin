import { VisionBudgetExceededError } from '../queue/vision-budget.service';
import { fakeGenerationQueue } from '../test-utils/fake-generation-queue';
import { GeminiPausedError } from '../vision/gemini-pause';
import { VisionBatchMismatchError } from '../vision/gemini-vision.provider';
import { ProducerBatchProcessor } from './producer-batch.processor';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const TEXT = 'Domaine familial du Castellet, au cœur de l’appellation Bandol, réputé pour ses mourvèdres de garde.';

const WINES = [
  { producer: 'Domaine Tempier', appellationRaw: 'Bandol', appellation: { canonicalName: 'Bandol', region: 'Provence' } },
  { producer: 'DOMAINE TEMPIER', appellationRaw: 'Bandol rosé', appellation: null },
  { producer: 'Trimbach', appellationRaw: 'Alsace', appellation: null },
];

type Answer = { items: Array<{ index: number; known: boolean; description: string | null }>; model: string; costCents: number };

function harness(opts: { answer?: (queries: unknown[]) => Promise<Answer>; overCap?: boolean } = {}) {
  const q = fakeGenerationQueue('producerProfile', { producerWines: WINES });
  q.clock.now = NOW;
  const provider = {
    describeProducersBatch: jest.fn(opts.answer ?? (async (queries: unknown[]) => ({
      items: queries.map((_, index) => ({ index, known: index === 0, description: index === 0 ? TEXT : null })),
      model: 'gemini-test',
      costCents: 3,
    }))),
  };
  const budget = { assertUnderShare: jest.fn(async () => { if (opts.overCap) throw new VisionBudgetExceededError(); }) };
  const pause = { currentPause: jest.fn(async () => null) };
  const processor = new ProducerBatchProcessor(q.prisma, provider as any, budget as any, pause as any);
  return { ...q, provider, budget, processor };
}

describe('ProducerBatchProcessor', () => {
  it('décrit tous les domaines du lot en un appel : connu → DONE, inconnu → UNKNOWN, coût réparti', async () => {
    const h = harness();
    h.add({ id: 'a', producerKey: 'domaine tempier', requestedAt: at(-3 * MIN) });
    h.add({ id: 'b', producerKey: 'trimbach', requestedAt: at(-3 * MIN + 1) });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 2 });
    expect(h.provider.describeProducersBatch).toHaveBeenCalledTimes(1);
    expect(h.provider.describeProducersBatch).toHaveBeenCalledWith([
      { producer: 'Domaine Tempier', appellations: ['Bandol', 'Bandol rosé'], region: 'Provence' },
      { producer: 'Trimbach', appellations: ['Alsace'], region: null },
    ]);
    expect(h.row('a')).toMatchObject({ status: 'DONE', description: TEXT, model: 'gemini-test', costCents: 2, attempts: 0, reservedUntil: null, generatedAt: expect.any(Date) });
    expect(h.row('b')).toMatchObject({ status: 'UNKNOWN', description: null, costCents: 2, reservedUntil: null });
  });

  it('ne prend jamais un descriptif saisi à la main, et ne l’écrase pas s’il est saisi pendant la génération', async () => {
    const h = harness({
      answer: async (queries) => {
        Object.assign(h.row('b'), { source: 'MANUEL', status: 'DONE', description: 'Texte saisi' });
        return { items: queries.map((_, index) => ({ index, known: true, description: TEXT })), model: 'm', costCents: 0 };
      },
    });
    h.add({ id: 'm', producerKey: 'trimbach', source: 'MANUEL', status: 'PENDING', requestedAt: at(-10 * MIN) });
    h.add({ id: 'b', producerKey: 'trimbach' });
    await h.processor.tick(NOW);
    expect(h.provider.describeProducersBatch.mock.calls[0][0]).toHaveLength(1);
    expect(h.row('m')).toMatchObject({ source: 'MANUEL', reservedUntil: null });
    expect(h.row('b')).toMatchObject({ source: 'MANUEL', description: 'Texte saisi' });
  });

  it('retire la demande d’un domaine qui n’a plus aucun vin, sans appeler Gemini pour lui', async () => {
    const h = harness();
    h.add({ id: 'gone', producerKey: 'clos disparu' });
    await h.processor.tick(NOW);
    expect(h.provider.describeProducersBatch).not.toHaveBeenCalled();
    expect(h.rows.find((r) => r.id === 'gone')).toBeUndefined();
  });

  it('un domaine absent de la réponse revient en attente avec une tentative ; échec après cinq', async () => {
    // Seul le premier domaine de chaque lot revient dans la réponse.
    const h = harness({ answer: async (queries) => ({ items: queries.length > 1 ? [{ index: 0, known: false, description: null }] : [], model: 'm', costCents: 0 }) });
    h.add({ id: 'a', producerKey: 'domaine tempier', requestedAt: at(-3 * MIN) });
    h.add({ id: 'b', producerKey: 'trimbach', requestedAt: at(-3 * MIN + 1), attempts: 3 });
    await h.processor.tick(NOW);
    expect(h.row('a')).toMatchObject({ status: 'UNKNOWN' });
    expect(h.row('b')).toMatchObject({ status: 'PENDING', attempts: 4, nextAttemptAt: at(320 * MIN), reservedUntil: null });
    h.clock.now = at(320 * MIN);
    await h.processor.tick(at(320 * MIN));
    expect(h.row('b')).toMatchObject({ status: 'FAILED', attempts: 5, errorMessage: 'Réponse de Gemini inexploitable' });
  });

  it('un lot mélangé compte une tentative pour chaque domaine', async () => {
    const h = harness({ answer: async () => { throw new VisionBatchMismatchError('Sortie du modèle invalide (indice dupliqué)'); } });
    h.add({ id: 'a', producerKey: 'domaine tempier' });
    h.add({ id: 'b', producerKey: 'trimbach' });
    await h.processor.tick(NOW);
    h.rows.forEach((r) => expect(r).toMatchObject({ status: 'PENDING', attempts: 1, nextAttemptAt: at(5 * MIN) }));
  });

  it('pause commune ou plafond : en attente avec le message, aucune tentative consommée, jamais en échec', async () => {
    const until = new Date('2026-10-16T13:00:00.000Z');
    const paused = harness({ answer: async () => { throw new GeminiPausedError(until, 'quota épuisé'); } });
    paused.add({ id: 'a', producerKey: 'domaine tempier', attempts: 4 });
    await paused.processor.tick(NOW);
    expect(paused.row('a')).toMatchObject({ status: 'PENDING', attempts: 4, nextAttemptAt: until, errorMessage: `Gemini en pause jusqu'à 15:00 (quota épuisé)` });

    const capped = harness({ overCap: true });
    capped.add({ id: 'a', producerKey: 'domaine tempier', attempts: 4 });
    await capped.processor.tick(NOW);
    expect(capped.provider.describeProducersBatch).not.toHaveBeenCalled();
    expect(capped.row('a')).toMatchObject({ status: 'PENDING', attempts: 4, nextAttemptAt: at(15 * MIN), errorMessage: new VisionBudgetExceededError().message });
  });
});
