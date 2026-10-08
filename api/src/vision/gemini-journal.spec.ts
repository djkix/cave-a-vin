import {
  GEMINI_PAUSE_REASON_KEY,
  GEMINI_PAUSE_UNTIL_KEY,
  GeminiJournal,
  GeminiPausedError,
  QUOTA_PAUSE_MS,
  SATURATION_PAUSE_MS,
  classifyFailure,
  pauseMessage,
} from './gemini-journal';
import { fakeGeminiPrisma as fakePrisma } from '../test-utils/fake-gemini-prisma';

const NOW = new Date('2026-10-08T12:00:00.000Z'); // 14:00 à Paris (heure d'été)

const quiet = { warn: jest.fn(), error: jest.fn() };

describe('pauseMessage', () => {
  it('donne l’heure de reprise à Paris et le motif', () => {
    expect(pauseMessage(new Date('2026-10-08T12:05:00.000Z'), 'modèle saturé')).toBe(`Gemini en pause jusqu'à 14:05 (modèle saturé)`);
    expect(pauseMessage(new Date('2026-12-08T22:30:00.000Z'), 'quota épuisé')).toBe(`Gemini en pause jusqu'à 23:30 (quota épuisé)`);
  });
});

describe('classifyFailure', () => {
  it('429 et 503 sont des refus de Google, le reste des erreurs', () => {
    expect(classifyFailure(new Error('[GoogleGenerativeAI Error]: … [503 Service Unavailable] busy'))).toMatchObject({ outcome: 'REFUSE', httpStatus: 503 });
    expect(classifyFailure(new Error('[GoogleGenerativeAI Error]: … [429 Too Many Requests] quota'))).toMatchObject({ outcome: 'REFUSE', httpStatus: 429 });
    expect(classifyFailure(new Error('[500 Internal Server Error] boom'))).toMatchObject({ outcome: 'ERREUR', httpStatus: 500 });
    expect(classifyFailure(new Error('Sortie du modèle invalide'))).toMatchObject({ outcome: 'ERREUR', httpStatus: null });
  });

  it('tronque le motif à 300 caractères et reprend le coût porté par l’erreur', () => {
    const e = Object.assign(new Error('x'.repeat(1000)), { costCents: 3 });
    const c = classifyFailure(e);
    expect(c.reason).toHaveLength(300);
    expect(c.costCents).toBe(3);
  });
});

describe('GeminiJournal', () => {
  it('sans réglage, pas de pause', async () => {
    const journal = new GeminiJournal(fakePrisma(), quiet);
    await expect(journal.currentPause(NOW)).resolves.toBeNull();
    await expect(journal.assertNotPaused(NOW)).resolves.toBeUndefined();
  });

  it('une pause en cours lève GeminiPausedError avec le message en français', async () => {
    const prisma = fakePrisma();
    prisma.settings.set(GEMINI_PAUSE_UNTIL_KEY, '2026-10-08T12:05:00.000Z');
    prisma.settings.set(GEMINI_PAUSE_REASON_KEY, 'modèle saturé');
    const journal = new GeminiJournal(prisma, quiet);
    const e = await journal.assertNotPaused(NOW).catch((x) => x);
    expect(e).toBeInstanceOf(GeminiPausedError);
    expect(e.message).toBe(`Gemini en pause jusqu'à 14:05 (modèle saturé)`);
    expect(e.until).toEqual(new Date('2026-10-08T12:05:00.000Z'));
  });

  it('une pause échue ou illisible ne bloque rien', async () => {
    const prisma = fakePrisma();
    prisma.settings.set(GEMINI_PAUSE_UNTIL_KEY, '2026-10-08T11:59:59.000Z');
    const journal = new GeminiJournal(prisma, quiet);
    await expect(journal.currentPause(NOW)).resolves.toBeNull();
    prisma.settings.set(GEMINI_PAUSE_UNTIL_KEY, 'n’importe quoi');
    await expect(journal.currentPause(NOW)).resolves.toBeNull();
  });

  it('une lecture de la pause impossible (base en panne) laisse passer l’appel', async () => {
    const prisma = fakePrisma();
    prisma.appSetting.findMany.mockRejectedValueOnce(new Error('base injoignable'));
    const log = { warn: jest.fn(), error: jest.fn() };
    await expect(new GeminiJournal(prisma, log).assertNotPaused(NOW)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('503 : pause de 5 minutes, « modèle saturé »', async () => {
    const prisma = fakePrisma();
    await new GeminiJournal(prisma, quiet).extendPause(503, NOW);
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe(new Date(NOW.getTime() + SATURATION_PAUSE_MS).toISOString());
    expect(prisma.settings.get(GEMINI_PAUSE_REASON_KEY)).toBe('modèle saturé');
    expect(SATURATION_PAUSE_MS).toBe(5 * 60_000);
  });

  it('429 : pause d’une heure, « quota épuisé »', async () => {
    const prisma = fakePrisma();
    await new GeminiJournal(prisma, quiet).extendPause(429, NOW);
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe(new Date(NOW.getTime() + QUOTA_PAUSE_MS).toISOString());
    expect(prisma.settings.get(GEMINI_PAUSE_REASON_KEY)).toBe('quota épuisé');
    expect(QUOTA_PAUSE_MS).toBe(60 * 60_000);
  });

  it('ne raccourcit jamais une pause plus longue déjà posée', async () => {
    const prisma = fakePrisma();
    const journal = new GeminiJournal(prisma, quiet);
    await journal.extendPause(429, NOW);
    await journal.extendPause(503, new Date(NOW.getTime() + 60_000));
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe(new Date(NOW.getTime() + QUOTA_PAUSE_MS).toISOString());
    expect(prisma.settings.get(GEMINI_PAUSE_REASON_KEY)).toBe('quota épuisé');
  });

  it('prolonge une pause plus courte', async () => {
    const prisma = fakePrisma();
    const journal = new GeminiJournal(prisma, quiet);
    await journal.extendPause(503, NOW);
    await journal.extendPause(429, NOW);
    expect(prisma.settings.get(GEMINI_PAUSE_UNTIL_KEY)).toBe(new Date(NOW.getTime() + QUOTA_PAUSE_MS).toISOString());
    expect(prisma.settings.get(GEMINI_PAUSE_REASON_KEY)).toBe('quota épuisé');
  });

  it('enregistre un appel, et ne lève jamais si l’écriture échoue', async () => {
    const prisma = fakePrisma();
    const log = { warn: jest.fn(), error: jest.fn() };
    const journal = new GeminiJournal(prisma, log);
    await journal.record({ usage: 'ACCORDS', outcome: 'OK', httpStatus: null, reason: null, costCents: 0, durationMs: 12 });
    expect(prisma.calls).toEqual([{ usage: 'ACCORDS', outcome: 'OK', httpStatus: null, reason: null, costCents: 0, durationMs: 12 }]);
    prisma.geminiCall.create.mockRejectedValueOnce(new Error('disque plein'));
    await expect(journal.record({ usage: 'ACCORDS', outcome: 'OK', httpStatus: null, reason: null, costCents: 0, durationMs: 1 })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('disque plein'));
  });

  it('une pause impossible à poser ne lève pas', async () => {
    const prisma = fakePrisma();
    prisma.$transaction.mockRejectedValueOnce(new Error('verrou'));
    const log = { warn: jest.fn(), error: jest.fn() };
    await expect(new GeminiJournal(prisma, log).extendPause(503, NOW)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('verrou'));
  });
});
