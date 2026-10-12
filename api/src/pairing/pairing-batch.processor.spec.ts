import { PAIRING_BUDGET_SHARE, VisionBudgetExceededError } from '../queue/vision-budget.service';
import { fakeGenerationQueue } from '../test-utils/fake-generation-queue';
import { GeminiPausedError } from '../vision/gemini-pause';
import { VisionBatchMismatchError } from '../vision/gemini-vision.provider';
import { GENERATION_RESERVATION_MS } from './generation-batch';
import { INTERRUPTED } from './generation-batch.processor';
import { PairingBatchProcessor } from './pairing-batch.processor';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;

const wine = (producer: string) => ({
  producer, cuvee: null, appellationRaw: 'Bandol brut', color: 'ROUGE', vintage: 2019,
  appellation: { canonicalName: 'Bandol', region: 'Provence' },
});
const WINES = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, wine(`Domaine ${i}`)]));

type Answer = { items: Array<{ index: number; dishes: string[] }>; model: string; costCents: number };
const all = (n: number, costCents = 0): Answer => ({
  items: Array.from({ length: n }, (_, index) => ({ index, dishes: [`Plat ${index}`] })),
  model: 'gemini-test',
  costCents,
});

function harness(opts: { answer?: (wines: unknown[]) => Promise<Answer>; overCap?: boolean; paused?: boolean } = {}) {
  const q = fakeGenerationQueue('pairing', { wines: WINES });
  q.clock.now = NOW;
  const provider = { suggestPairingsBatch: jest.fn(opts.answer ?? (async (wines: unknown[]) => all(wines.length))) };
  const budget = { assertUnderShare: jest.fn(async () => { if (opts.overCap) throw new VisionBudgetExceededError(); }) };
  const pause = { currentPause: jest.fn(async () => (opts.paused ? { until: at(5 * MIN), reason: 'modèle saturé' } : null)) };
  const processor = new PairingBatchProcessor(q.prisma, provider as any, budget as any, pause as any);
  const add = (n: number, row: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => q.add({ id: `p${i}`, wineId: `w${i}`, requestedAt: at(-3 * MIN + i), ...row }));
  return { ...q, provider, budget, pause, processor, add };
}

describe('PairingBatchProcessor — lots', () => {
  it('génère tout le lot en un appel et enregistre chaque vin, coût réparti', async () => {
    const h = harness({ answer: async (wines) => all(wines.length, 7) });
    h.add(3);
    expect(await h.processor.tick(NOW)).toEqual({ processed: 3 });
    expect(h.budget.assertUnderShare).toHaveBeenCalledTimes(1);
    expect(h.budget.assertUnderShare).toHaveBeenCalledWith(PAIRING_BUDGET_SHARE);
    expect(h.provider.suggestPairingsBatch).toHaveBeenCalledTimes(1);
    expect(h.provider.suggestPairingsBatch).toHaveBeenCalledWith([0, 1, 2].map((i) => ({
      producer: `Domaine ${i}`, cuvee: null, appellation: 'Bandol', region: 'Provence', color: 'ROUGE', vintage: 2019,
    })));
    // 7 ct sur 3 vins, exactement : 3, 2, 2.
    expect(h.rows.map((r) => r.costCents)).toEqual([3, 2, 2]);
    h.rows.forEach((r, i) => expect(r).toMatchObject({
      status: 'DONE', dishes: [`Plat ${i}`], model: 'gemini-test', errorMessage: null,
      generatedAt: expect.any(Date), attempts: 0, nextAttemptAt: null, reservedUntil: null,
    }));
  });

  it('attend tant que moins de dix vins sont prêts et que le plus ancien a moins de 2 min', async () => {
    const h = harness();
    h.add(9, { requestedAt: at(-MIN) });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
    expect(h.provider.suggestPairingsBatch).not.toHaveBeenCalled();
    h.rows.forEach((r) => expect(r.reservedUntil).toBeNull());
  });

  it('dix vins prêts, même récents : un lot de dix ; les suivants attendent le passage suivant', async () => {
    const h = harness();
    h.add(12, { requestedAt: at(-1000) });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 10 });
    expect(h.provider.suggestPairingsBatch.mock.calls[0][0]).toHaveLength(10);
    expect(h.rows.filter((r) => r.status === 'DONE')).toHaveLength(10);
  });

  it('pendant une pause commune, ne réserve rien et n’appelle pas Gemini', async () => {
    const h = harness({ paused: true });
    h.add(10);
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
    expect(h.provider.suggestPairingsBatch).not.toHaveBeenCalled();
    h.rows.forEach((r) => expect(r).toMatchObject({ status: 'PENDING', reservedUntil: null, attempts: 0 }));
  });
});

describe('PairingBatchProcessor — réponses partielles ou invalides', () => {
  it('un vin absent de la réponse (ou invalide) revient en attente avec une tentative ; les autres sont enregistrés et paient l’appel', async () => {
    const h = harness({ answer: async () => ({ items: [{ index: 0, dishes: ['Agneau'] }, { index: 2, dishes: ['Daube'] }], model: 'm', costCents: 3 }) });
    h.add(3);
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'DONE', dishes: ['Agneau'], costCents: 2 });
    expect(h.row('p2')).toMatchObject({ status: 'DONE', dishes: ['Daube'], costCents: 1 });
    expect(h.row('p1')).toMatchObject({
      status: 'PENDING', attempts: 1, reservedUntil: null, nextAttemptAt: at(5 * MIN),
      errorMessage: 'Réponse de Gemini inexploitable, nouvel essai automatique',
    });
  });

  it('après cinq tentatives, le vin passe en échec avec le message habituel', async () => {
    const h = harness({ answer: async () => ({ items: [], model: 'm', costCents: 0 }) });
    h.add(1, { attempts: 4 });
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'FAILED', attempts: 5, nextAttemptAt: null, reservedUntil: null, errorMessage: 'Réponse de Gemini inexploitable' });
  });

  it('un lot mélangé (JSON illisible, indices) compte une tentative pour chaque vin', async () => {
    const h = harness({ answer: async () => { throw new VisionBatchMismatchError('Sortie du modèle invalide (JSON illisible)', 2); } });
    h.add(2);
    h.row('p1').attempts = 4;
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 1, nextAttemptAt: at(5 * MIN), reservedUntil: null });
    expect(h.row('p1')).toMatchObject({ status: 'FAILED', attempts: 5, errorMessage: 'Réponse de Gemini inexploitable' });
  });

  it('une panne passagère ne consomme aucune tentative : attente de l’âge de la demande (5 min à 6 h), jamais d’échec avant 7 jours', async () => {
    const h = harness({ answer: async () => { throw new Error('fetch failed'); } });
    h.add(3, { attempts: 0 });
    h.row('p0').requestedAt = at(-3 * MIN);
    h.row('p1').requestedAt = at(-90 * MIN);
    h.row('p2').requestedAt = at(-3 * 24 * 60 * MIN);
    await h.processor.tick(NOW);
    const reason = 'Analyse reportée : service Gemini injoignable, reprise automatique';
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: at(5 * MIN), reservedUntil: null, errorMessage: reason });
    expect(h.row('p1')).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: at(90 * MIN), errorMessage: reason });
    expect(h.row('p2')).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: at(6 * 60 * MIN), errorMessage: reason });
  });

  it('une panne passagère abandonne une demande vieille de 7 jours, avec le motif du report suivi de « — abandon »', async () => {
    const h = harness({ answer: async () => { throw new Error('[500 Internal Server Error] boom'); } });
    h.add(1, { requestedAt: at(-7 * 24 * 60 * MIN) });
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({
      status: 'FAILED', attempts: 0, nextAttemptAt: null, reservedUntil: null,
      errorMessage: 'Analyse reportée : service Gemini momentanément saturé, reprise automatique — abandon',
    });
  });

  it('après un 429, la reprise attend au moins la fin de la pause commune (1 h)', async () => {
    const h = harness({ answer: async () => { throw new Error('[429 Too Many Requests] quota'); } });
    h.add(1);
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: at(60 * MIN) });
  });

  it('un appel bloqué est abandonné au délai : panne passagère, aucune tentative consommée', async () => {
    const h = harness({ answer: () => new Promise<Answer>(() => undefined) });
    h.processor.callTimeoutMs = 10;
    h.add(1);
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 0, reservedUntil: null, nextAttemptAt: at(5 * MIN) });
  });

  it('une erreur de configuration ne consomme aucune tentative ; abandon au bout de 7 jours seulement', async () => {
    const h = harness({ answer: async () => { throw new Error('[400 Bad Request] API key not valid'); } });
    h.add(2);
    h.row('p1').requestedAt = at(-8 * 24 * 60 * MIN);
    h.row('p1').attempts = 0;
    await h.processor.tick(NOW);
    const reason = 'Génération reportée : configuration Gemini à vérifier, reprise automatique';
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 0, errorMessage: reason, nextAttemptAt: at(5 * MIN) });
    expect(h.row('p1')).toMatchObject({ status: 'FAILED', attempts: 0, errorMessage: `${reason} — abandon` });
  });
});

describe('PairingBatchProcessor — pause commune et budget : aucune tentative consommée', () => {
  const until = new Date('2026-10-16T12:05:00.000Z');

  it('pause posée pendant le passage : tout le lot attend la fin de la pause avec son message, jamais en échec', async () => {
    const h = harness({ answer: async () => { throw new GeminiPausedError(until, 'modèle saturé'); } });
    h.add(2);
    h.row('p1').attempts = 4;
    await h.processor.tick(NOW);
    h.rows.forEach((r) => expect(r).toMatchObject({
      status: 'PENDING', nextAttemptAt: until, reservedUntil: null,
      errorMessage: `Gemini en pause jusqu'à 14:05 (modèle saturé)`,
    }));
    expect(h.rows.map((r) => r.attempts)).toEqual([0, 4]);
  });

  it('plafond atteint : vérifié une fois, aucun appel, report fixe de 15 min, jamais en échec', async () => {
    const h = harness({ overCap: true });
    h.add(2);
    h.row('p1').attempts = 4;
    await h.processor.tick(NOW);
    expect(h.provider.suggestPairingsBatch).not.toHaveBeenCalled();
    h.rows.forEach((r) => expect(r).toMatchObject({
      status: 'PENDING', nextAttemptAt: at(15 * MIN), reservedUntil: null,
      errorMessage: new VisionBudgetExceededError().message,
    }));
    expect(h.rows.map((r) => r.attempts)).toEqual([0, 4]);
  });

  it('une demande reportée ne repart pas avant son heure', async () => {
    const h = harness();
    h.add(1, { nextAttemptAt: at(MIN) });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
    h.clock.now = at(MIN);
    expect(await h.processor.tick(at(MIN))).toEqual({ processed: 1 });
  });
});

describe('PairingBatchProcessor — réservations échues', () => {
  it('reprend une demande dont la réservation a expiré, en comptant une tentative ; abandon à la cinquième', async () => {
    const h = harness({ paused: true });
    h.add(2, { reservedUntil: at(-1) });
    h.row('p1').attempts = 4;
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 1, reservedUntil: null });
    expect(h.row('p1')).toMatchObject({ status: 'FAILED', attempts: 5, reservedUntil: null, errorMessage: INTERRUPTED });
  });

  it('une réservation encore valide n’est ni reprise ni relancée', async () => {
    const h = harness();
    h.add(1, { reservedUntil: at(GENERATION_RESERVATION_MS) });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
    expect(h.row('p0')).toMatchObject({ attempts: 0, reservedUntil: at(GENERATION_RESERVATION_MS) });
  });

  it('n’écrit jamais sur une demande reprise par un autre passage (réservation changée)', async () => {
    const h = harness({
      answer: async (wines) => {
        h.row('p0').reservedUntil = at(10 * MIN); // un autre passage l'a reprise entre-temps
        return all(wines.length);
      },
    });
    h.add(1);
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', reservedUntil: at(10 * MIN) });
  });
});

describe('PairingBatchProcessor — une demande difficile ne fait plus échouer le lot', () => {
  it('une demande déjà revenue inexploitable, en tête de file, part seule', async () => {
    const h = harness();
    h.add(10);
    h.row('p0').attempts = 1;
    expect(await h.processor.tick(NOW)).toEqual({ processed: 1 });
    expect(h.provider.suggestPairingsBatch.mock.calls[0][0]).toHaveLength(1);
    expect(h.row('p0')).toMatchObject({ status: 'DONE' });
    expect(h.rows.filter((r) => r.status === 'PENDING' && r.reservedUntil === null)).toHaveLength(9);
    expect(await h.processor.tick(NOW)).toEqual({ processed: 9 });
    expect(h.provider.suggestPairingsBatch.mock.calls[1][0]).toHaveLength(9);
  });

  it('deux vins décrits à l’identique partent en une seule ligne, la réponse est copiée sur chacun', async () => {
    const h = harness({ answer: async (wines) => ({ items: wines.map((_, index) => ({ index, dishes: [`Plat ${index}`] })), model: 'm', costCents: 3 }) });
    h.add(3);
    h.row('p2').wineId = 'w0'; // même description que p0
    await h.processor.tick(NOW);
    expect(h.provider.suggestPairingsBatch.mock.calls[0][0]).toHaveLength(2);
    expect(h.row('p0')).toMatchObject({ status: 'DONE', dishes: ['Plat 0'] });
    expect(h.row('p2')).toMatchObject({ status: 'DONE', dishes: ['Plat 0'] });
    expect(h.row('p1')).toMatchObject({ status: 'DONE', dishes: ['Plat 1'] });
    expect(h.rows.reduce((sum, r) => sum + (r.costCents as number), 0)).toBe(3);
  });

  it('une ligne partagée absente de la réponse renvoie chacun de ses vins en attente', async () => {
    const h = harness({ answer: async () => ({ items: [{ index: 1, dishes: ['Daube'] }], model: 'm', costCents: 0 }) });
    h.add(3);
    h.row('p2').wineId = 'w0';
    await h.processor.tick(NOW);
    expect(h.row('p0')).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(h.row('p2')).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(h.row('p1')).toMatchObject({ status: 'DONE' });
  });
});
