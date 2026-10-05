import {
  ENTRY_BATCH_MAX_WAIT_MS,
  ENTRY_BATCH_SIZE,
  ENTRY_BATCH_TICK_MS,
  RESERVATION_MS,
  createEntryBatchLoop,
  shouldRun,
  splitCost,
} from './entry-batch';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const recent = (n: number) => Array.from({ length: n }, () => ({ createdAt: ago(5_000), nextAttemptAt: null }));

describe('constantes du lot', () => {
  it('reprend exactement les valeurs du plan', () => {
    expect(ENTRY_BATCH_SIZE).toBe(8);
    expect(ENTRY_BATCH_MAX_WAIT_MS).toBe(45_000);
    expect(ENTRY_BATCH_TICK_MS).toBe(15_000);
    expect(RESERVATION_MS).toBe(5 * 60_000);
  });
});

describe('shouldRun', () => {
  it('ne lance rien sans candidate', () => {
    expect(shouldRun([], NOW)).toBe(false);
  });

  it('attend avec 7 photos récentes', () => {
    expect(shouldRun(recent(7), NOW)).toBe(false);
  });

  it('lance un lot dès 8 photos', () => {
    expect(shouldRun(recent(8), NOW)).toBe(true);
  });

  it('lance un lot pour une seule photo de 46 s', () => {
    expect(shouldRun([{ createdAt: ago(46_000), nextAttemptAt: null }], NOW)).toBe(true);
  });

  it('lance un lot pile à 45 s', () => {
    expect(shouldRun([{ createdAt: ago(45_000), nextAttemptAt: null }], NOW)).toBe(true);
  });

  it('relance une photo reportée dès que son heure est passée', () => {
    expect(shouldRun([{ createdAt: ago(5_000), nextAttemptAt: ago(1) }], NOW)).toBe(true);
  });

  it('ne relance pas une photo reportée dont l’heure n’est pas venue', () => {
    expect(shouldRun([{ createdAt: ago(5_000), nextAttemptAt: new Date(NOW.getTime() + 1_000) }], NOW)).toBe(false);
  });
});

describe('splitCost', () => {
  it('répartit le coût en arrondissant au centime supérieur', () => {
    expect(splitCost(10, 8)).toBe(2);
    expect(splitCost(16, 8)).toBe(2);
    expect(splitCost(0, 8)).toBe(0);
    expect(splitCost(3, 1)).toBe(3);
  });
});

describe('createEntryBatchLoop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passe une fois au démarrage puis à chaque intervalle', async () => {
    const tick = jest.fn(async () => undefined);
    const loop = createEntryBatchLoop(tick, 1000, jest.fn());
    loop.start();
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it('ne lance jamais deux passages simultanés', async () => {
    let release!: () => void;
    const tick = jest.fn(() => new Promise<void>((r) => (release = r)));
    const loop = createEntryBatchLoop(tick, 1000, jest.fn());
    loop.start();
    await jest.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    release();
    await loop.stop();
  });

  it('journalise une erreur de passage sans arrêter la boucle', async () => {
    const onError = jest.fn();
    const tick = jest.fn().mockRejectedValueOnce(new Error('base injoignable')).mockResolvedValue(undefined);
    const loop = createEntryBatchLoop(tick, 1000, onError);
    loop.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'base injoignable' }));
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it('stop arrête l’intervalle et attend le passage en cours', async () => {
    let release!: () => void;
    let finished = false;
    const tick = jest.fn(() => new Promise<void>((r) => (release = r)).then(() => { finished = true; }));
    const loop = createEntryBatchLoop(tick, 1000, jest.fn());
    loop.start();
    const stopped = loop.stop();
    let stopDone = false;
    void stopped.then(() => (stopDone = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(stopDone).toBe(false);
    release();
    await stopped;
    expect(finished).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
