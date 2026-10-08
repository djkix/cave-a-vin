import { GeminiPausedError } from '../vision/gemini-pause';
import { Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PAIRING_BUDGET_SHARE, VisionBudgetExceededError } from '../queue/vision-budget.service';
import { ProducerInvalidOutputError } from '../vision/producer-output';
import { ProducerProcessor } from './producer.processor';

const KEY = 'domaine tempier';
const DESCRIPTION = 'Domaine familial du Castellet, au cœur de l’appellation Bandol, réputé pour ses mourvèdres.';
const wines = [
  { producer: 'Domaine Tempier', appellationRaw: 'Bandol', appellation: { canonicalName: 'Bandol', region: 'Provence' } },
  { producer: 'DOMAINE TEMPIER', appellationRaw: 'bandol rouge', appellation: { canonicalName: 'Bandol', region: 'Provence' } },
  { producer: 'Château Simone', appellationRaw: 'Palette', appellation: null },
];

function harness(opts: { wines?: unknown[]; profile?: unknown; describe?: jest.Mock; overCap?: boolean; conflictOnce?: boolean } = {}) {
  let conflicts = opts.conflictOnce ? 1 : 0;
  const upsert = jest.fn(async () => {
    if (conflicts-- > 0) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    return {};
  });
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const prisma = {
    wine: { findMany: jest.fn(async () => opts.wines ?? wines) },
    producerProfile: { findUnique: jest.fn(async () => opts.profile ?? null), upsert, updateMany },
  };
  const provider = {
    describeProducer: opts.describe ?? jest.fn(async () => ({ known: true, description: DESCRIPTION, model: 'gemini-test', costCents: 1 })),
  };
  const budget = { assertUnderShare: jest.fn(async () => { if (opts.overCap) throw new VisionBudgetExceededError(); }) };
  return { prisma, upsert, updateMany, provider, budget, processor: new ProducerProcessor(prisma as any, provider as any, budget as any) };
}

const onGemini = { where: { producerKey: KEY, source: 'GEMINI' } };

describe('ProducerProcessor', () => {
  it('enregistre le descriptif d’un domaine connu (DONE)', async () => {
    const h = harness();
    await h.processor.process(KEY);
    expect(h.upsert).toHaveBeenCalledWith({ where: { producerKey: KEY }, create: { producerKey: KEY, displayName: 'Domaine Tempier' }, update: {} });
    expect(h.budget.assertUnderShare).toHaveBeenCalledWith(PAIRING_BUDGET_SHARE);
    expect(h.provider.describeProducer).toHaveBeenCalledWith({ producer: 'Domaine Tempier', appellations: ['Bandol'], region: 'Provence' });
    expect(h.updateMany).toHaveBeenCalledWith({
      ...onGemini,
      data: { status: 'DONE', description: DESCRIPTION, model: 'gemini-test', costCents: 1, errorMessage: null, generatedAt: expect.any(Date) },
    });
  });

  it('réessaie une fois la création du profil quand une saisie concurrente l’a créé (P2002)', async () => {
    const h = harness({ conflictOnce: true });
    await h.processor.process(KEY);
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.updateMany).toHaveBeenCalledWith(expect.objectContaining({ ...onGemini, data: expect.objectContaining({ status: 'DONE' }) }));
  });

  it('note un domaine peu documenté (UNKNOWN), sans texte', async () => {
    const h = harness({ describe: jest.fn(async () => ({ known: false, description: null, model: 'gemini-test', costCents: 0 })) });
    await h.processor.process(KEY);
    expect(h.updateMany).toHaveBeenCalledWith({
      ...onGemini,
      data: { status: 'UNKNOWN', description: null, model: 'gemini-test', costCents: 0, errorMessage: null, generatedAt: expect.any(Date) },
    });
  });

  it('se rabat sur l’appellation lue quand elle n’est pas reconnue', async () => {
    const h = harness({ wines: [{ producer: 'Château Simone', appellationRaw: 'Palette', appellation: null }] });
    await h.processor.process('chateau simone');
    expect(h.provider.describeProducer).toHaveBeenCalledWith({ producer: 'Château Simone', appellations: ['Palette'], region: null });
  });

  it('ne touche jamais un texte saisi à la main (MANUEL)', async () => {
    const h = harness({ profile: { producerKey: KEY, source: 'MANUEL', status: 'DONE' } });
    await h.processor.process(KEY);
    expect(h.provider.describeProducer).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('ignore un domaine dont plus aucun vin ne porte la clé', async () => {
    const h = harness();
    await h.processor.process('domaine disparu');
    expect(h.provider.describeProducer).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('reporte sur une indisponibilité de Gemini : reste en attente et relance', async () => {
    const h = harness({ describe: jest.fn(async () => { throw new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] busy'); }) });
    await expect(h.processor.process(KEY, false)).rejects.toThrow(/503/);
    expect(h.updateMany).toHaveBeenCalledWith({ ...onGemini, data: { status: 'PENDING', errorMessage: expect.stringContaining('reprise automatique') } });
  });

  it('attend le mois suivant quand le plafond est atteint', async () => {
    const h = harness({ overCap: true });
    await expect(h.processor.process(KEY, false)).rejects.toBeInstanceOf(VisionBudgetExceededError);
    expect(h.provider.describeProducer).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
  });

  it('abandonne au dernier essai d’une panne passagère', async () => {
    const h = harness({ describe: jest.fn(async () => { throw new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] busy'); }) });
    await expect(h.processor.process(KEY, true)).rejects.toThrow(/503/);
    expect(h.updateMany).toHaveBeenCalledWith({ ...onGemini, data: { status: 'FAILED', errorMessage: expect.stringContaining('abandon') } });
  });

  it('échoue définitivement sur une réponse inexploitable', async () => {
    const h = harness({ describe: jest.fn(async () => { throw new ProducerInvalidOutputError('Sortie du modèle invalide : descriptif trop court'); }) });
    await expect(h.processor.process(KEY, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.updateMany).toHaveBeenCalledWith({ ...onGemini, data: { status: 'FAILED', errorMessage: 'Réponse de Gemini inexploitable' } });
  });

  it('échoue définitivement sur une erreur de configuration, sans l’attribuer à la réponse', async () => {
    const h = harness({ describe: jest.fn(async () => { throw new Error('[GoogleGenerativeAI Error]: [400 Bad Request] API key not valid'); }) });
    await expect(h.processor.process(KEY, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.updateMany).toHaveBeenCalledWith({ ...onGemini, data: { status: 'FAILED', errorMessage: 'Génération impossible : configuration Gemini à vérifier' } });
  });
});

describe('ProducerProcessor — pause commune de Gemini', () => {
  const PAUSED = new GeminiPausedError(new Date('2026-10-08T12:05:00.000Z'), 'modèle saturé');
const PAUSE_MESSAGE = `Gemini en pause jusqu'à 14:05 (modèle saturé)`;

  it.each([false, true])('reste en attente avec le message de la pause et relaie la pause (dernier essai : %s), sans échec', async (isLast) => {
    const h = harness({ describe: jest.fn(async () => { throw PAUSED; }) });
    await expect(h.processor.process(KEY, isLast)).rejects.toBe(PAUSED);
    expect(h.updateMany).toHaveBeenCalledWith({ ...onGemini, data: { status: 'PENDING', errorMessage: PAUSE_MESSAGE } });
    expect(h.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
  });
});
