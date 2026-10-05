import { UnrecoverableError } from 'bullmq';
import { VisionBudgetExceededError } from '../queue/vision-budget.service';
import { PairingInvalidOutputError } from '../vision/pairing-output';
import { PairingProcessor } from './pairing.processor';

const wine = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE',
  appellation: { canonicalName: 'Bandol', region: 'Provence' },
};

function harness(opts: { wine?: unknown; suggest?: jest.Mock; overCap?: boolean } = {}) {
  const upsert = jest.fn(async () => ({}));
  const update = jest.fn(async () => ({}));
  const prisma = {
    wine: { findUnique: jest.fn(async () => ('wine' in opts ? opts.wine : wine)) },
    pairing: { upsert, update },
  };
  const provider = { suggestPairings: opts.suggest ?? jest.fn(async () => ({ dishes: ['Agneau', 'Daube'], model: 'gemini-test', costCents: 1 })) };
  const budget = { assertUnderCap: jest.fn(async () => { if (opts.overCap) throw new VisionBudgetExceededError(); }) };
  return { upsert, update, provider, processor: new PairingProcessor(prisma as any, provider as any, budget as any) };
}

describe('PairingProcessor', () => {
  it('enregistre les plats suggérés', async () => {
    const h = harness();
    await h.processor.process('w1');
    expect(h.provider.suggestPairings).toHaveBeenCalledWith({
      producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', region: 'Provence', color: 'ROUGE', vintage: 2019,
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { wineId: 'w1' },
      data: { status: 'DONE', dishes: ['Agneau', 'Daube'], model: 'gemini-test', costCents: 1, errorMessage: null, generatedAt: expect.any(Date) },
    });
  });

  it('ignore un vin supprimé entre-temps', async () => {
    const h = harness({ wine: null });
    await h.processor.process('w1');
    expect(h.provider.suggestPairings).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('reporte sur une indisponibilité de Gemini : reste en attente et relance', async () => {
    const h = harness({ suggest: jest.fn(async () => { throw new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] busy'); }) });
    await expect(h.processor.process('w1', false)).rejects.toThrow(/503/);
    expect(h.update).toHaveBeenCalledWith({ where: { wineId: 'w1' }, data: { status: 'PENDING', errorMessage: expect.stringContaining('reprise automatique') } });
  });

  it('attend le mois suivant quand le plafond est atteint', async () => {
    const h = harness({ overCap: true });
    await expect(h.processor.process('w1', false)).rejects.toBeInstanceOf(VisionBudgetExceededError);
    expect(h.provider.suggestPairings).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
  });

  it('échoue définitivement sur une réponse inexploitable', async () => {
    const h = harness({ suggest: jest.fn(async () => { throw new PairingInvalidOutputError('Sortie du modèle invalide : 0 plats'); }) });
    await expect(h.processor.process('w1', false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.update).toHaveBeenCalledWith({ where: { wineId: 'w1' }, data: { status: 'FAILED', errorMessage: 'Réponse de Gemini inexploitable' } });
  });

  it('échoue définitivement sur une erreur de configuration, sans l’attribuer à la réponse', async () => {
    const h = harness({ suggest: jest.fn(async () => { throw new Error('[GoogleGenerativeAI Error]: [400 Bad Request] API key not valid'); }) });
    await expect(h.processor.process('w1', false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.update).toHaveBeenCalledWith({
      where: { wineId: 'w1' },
      data: { status: 'FAILED', errorMessage: 'Génération impossible : configuration Gemini à vérifier' },
    });
  });
});
