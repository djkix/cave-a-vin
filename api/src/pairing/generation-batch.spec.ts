import {
  GENERATION_BATCH_MAX_WAIT_MS,
  GENERATION_BATCH_SIZE,
  GENERATION_BATCH_TICK_MS,
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RESERVATION_MS,
  generationRetryDelay,
  shouldRunGeneration,
} from './generation-batch';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const recent = (n: number) => Array.from({ length: n }, () => ({ requestedAt: ago(5_000) }));

describe('constantes des lots d’accords et de descriptifs', () => {
  it('reprend exactement les valeurs approuvées', () => {
    expect(GENERATION_BATCH_SIZE).toBe(10);
    expect(GENERATION_BATCH_MAX_WAIT_MS).toBe(2 * 60_000);
    expect(GENERATION_BATCH_TICK_MS).toBe(15_000);
    expect(GENERATION_RESERVATION_MS).toBe(5 * 60_000);
    expect(GENERATION_MAX_ATTEMPTS).toBe(5);
  });
});

describe('shouldRunGeneration', () => {
  it('ne lance rien sans demande prête', () => {
    expect(shouldRunGeneration([], NOW)).toBe(false);
  });

  it('lance un lot dès 10 demandes prêtes, même toutes récentes', () => {
    expect(shouldRunGeneration(recent(10), NOW)).toBe(true);
  });

  it('attend avec 9 demandes récentes', () => {
    expect(shouldRunGeneration(recent(9), NOW)).toBe(false);
  });

  it('attend tant que la plus ancienne demande a moins de 2 min', () => {
    expect(shouldRunGeneration([{ requestedAt: ago(2 * 60_000 - 1) }], NOW)).toBe(false);
  });

  it('lance un lot incomplet quand la plus ancienne demande attend depuis 2 min', () => {
    expect(shouldRunGeneration([{ requestedAt: ago(2 * 60_000) }], NOW)).toBe(true);
    expect(shouldRunGeneration([...recent(3), { requestedAt: ago(10 * 60_000) }], NOW)).toBe(true);
  });
});

describe('generationRetryDelay', () => {
  const err = (m: string) => new Error(m);

  it('attend au moins 5 min, puis de plus en plus longtemps', () => {
    expect(generationRetryDelay(1)).toBe(5 * 60_000);
    expect(generationRetryDelay(2)).toBe(20 * 60_000);
    expect(generationRetryDelay(3)).toBe(80 * 60_000);
    expect(generationRetryDelay(4, err('fetch failed'))).toBe(320 * 60_000);
  });

  it('après un 429, au moins l’heure de la pause commune', () => {
    expect(generationRetryDelay(1, err('[429 Too Many Requests] quota'))).toBe(60 * 60_000);
    expect(generationRetryDelay(3, err('[429 Too Many Requests] quota'))).toBe(80 * 60_000);
  });
});
