import {
  GENERATION_BATCH_MAX_WAIT_MS,
  GENERATION_BATCH_SIZE,
  GENERATION_BATCH_TICK_MS,
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RESERVATION_MS,
  GENERATION_GIVE_UP_MS,
  invalidAnswerRetryDelay,
  shouldRunGeneration,
  transientRetryDelay,
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

describe('invalidAnswerRetryDelay (réponse inexploitable : une tentative consommée)', () => {
  it('attend 5 min, puis de plus en plus longtemps', () => {
    expect(invalidAnswerRetryDelay(1)).toBe(5 * 60_000);
    expect(invalidAnswerRetryDelay(2)).toBe(20 * 60_000);
    expect(invalidAnswerRetryDelay(4)).toBe(320 * 60_000);
  });
});

describe('transientRetryDelay (panne ou configuration : aucune tentative consommée)', () => {
  const err = (m: string) => new Error(m);
  const requested = (ms: number) => new Date(NOW.getTime() - ms);
  const MIN = 60_000;

  it('attend l’âge de la demande, borné entre 5 min et 6 h', () => {
    expect(transientRetryDelay(requested(30_000), NOW, err('fetch failed'))).toBe(5 * MIN);
    expect(transientRetryDelay(requested(40 * MIN), NOW, err('fetch failed'))).toBe(40 * MIN);
    expect(transientRetryDelay(requested(3 * 24 * 60 * MIN), NOW, err('fetch failed'))).toBe(6 * 60 * MIN);
  });

  it('jamais avant la fin de la pause commune posée par un refus de Google', () => {
    expect(transientRetryDelay(requested(MIN), NOW, err('[429 Too Many Requests] quota'))).toBe(60 * MIN);
    expect(transientRetryDelay(requested(MIN), NOW, err('[503 Service Unavailable] busy'))).toBe(5 * MIN);
    expect(transientRetryDelay(requested(2 * 60 * MIN), NOW, err('[429 Too Many Requests] quota'))).toBe(2 * 60 * MIN);
  });

  it('abandon au bout de 7 jours de demande', () => {
    expect(GENERATION_GIVE_UP_MS).toBe(7 * 24 * 60 * MIN);
  });
});
