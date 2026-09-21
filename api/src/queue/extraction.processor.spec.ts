import { UnrecoverableError } from 'bullmq';
import { VisionInvalidOutputError } from '../vision/gemini-vision.provider';
import { ExtractionProcessor } from './extraction.processor';
import { VisionBudgetExceededError } from './vision-budget.service';

const GEMINI_503 = new Error('[503 Service Unavailable] This model is currently experiencing high demand.');

function harness(opts: { visionError?: Error } = {}) {
  const photo: any = { id: 'p1', status: 'PENDING' };
  const prisma = { photo: { update: jest.fn(async ({ data }: any) => Object.assign(photo, data)) } };
  const photos = { readNormalized: jest.fn(async () => Buffer.from('img')) };
  const vision = {
    extractWineLabel: jest.fn(async () => {
      if (opts.visionError) throw opts.visionError;
      return { extraction: { producer: { value: 'X', confidence: 1 } }, raw: { producteur: { value: 'X', confidence: 1 } }, model: 'm', latencyMs: 12, costCents: 1 };
    }),
  };
  const budget = { assertUnderCap: jest.fn(async () => undefined) };
  return { photo, prisma, photos, vision, budget, processor: new ExtractionProcessor(prisma as any, photos as any, vision as any, budget as any) };
}

describe('ExtractionProcessor.process', () => {
  it('marks PROCESSING then DONE with the raw JSON kept verbatim', async () => {
    const h = harness();
    await h.processor.process('p1');
    expect(h.prisma.photo.update.mock.calls[0][0].data.status).toBe('PROCESSING');
    expect(h.photo.status).toBe('DONE');
    expect(h.photo.rawExtraction).toEqual({ producteur: { value: 'X', confidence: 1 } });
    expect(h.photo.costCents).toBe(1);
  });

  it('checks the budget before calling the model', async () => {
    const h = harness();
    h.budget.assertUnderCap.mockRejectedValueOnce(new VisionBudgetExceededError());
    await expect(h.processor.process('p1')).rejects.toBeInstanceOf(VisionBudgetExceededError);
    expect(h.vision.extractWineLabel).not.toHaveBeenCalled();
  });

  describe('panne passagère — la photo retourne en attente, jamais en échec', () => {
    it('remet la photo en PENDING avec un motif lisible et relance le réessai', async () => {
      const h = harness({ visionError: GEMINI_503 });
      await expect(h.processor.process('p1', false)).rejects.toBe(GEMINI_503);
      expect(h.photo.status).toBe('PENDING');
      expect(h.photo.errorMessage).toBe('Analyse reportée : service Gemini momentanément saturé, reprise automatique');
    });

    it('ne relance pas une UnrecoverableError, sinon BullMQ arrêterait de réessayer', async () => {
      const h = harness({ visionError: GEMINI_503 });
      await expect(h.processor.process('p1', false)).rejects.not.toBeInstanceOf(UnrecoverableError);
    });

    it('reporte aussi un plafond mensuel atteint : il repart au mois suivant', async () => {
      const h = harness();
      h.budget.assertUnderCap.mockRejectedValueOnce(new VisionBudgetExceededError());
      await expect(h.processor.process('p1', false)).rejects.toBeInstanceOf(VisionBudgetExceededError);
      expect(h.photo.status).toBe('PENDING');
      expect(h.photo.errorMessage).toContain('Plafond mensuel');
    });

    it('n’abandonne qu’à la dernière tentative, en disant que le report a été épuisé', async () => {
      const h = harness({ visionError: GEMINI_503 });
      await expect(h.processor.process('p1', true)).rejects.toBe(GEMINI_503);
      expect(h.photo.status).toBe('FAILED');
      expect(h.photo.errorMessage).toContain('abandon après 1000 tentatives');
    });
  });

  describe('erreur définitive — échec immédiat pour proposer la saisie manuelle', () => {
    it('met la photo en FAILED dès la première tentative et coupe la file', async () => {
      const invalid = new VisionInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
      const h = harness({ visionError: invalid });
      await expect(h.processor.process('p1', false)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(h.photo.status).toBe('FAILED');
      expect(h.photo.errorMessage).toBe('Sortie du modèle invalide (JSON illisible)');
    });

    it('traite une clé d’API invalide comme définitive, sans mille réessais inutiles', async () => {
      const h = harness({ visionError: new Error('[400 Bad Request] API key not valid. Please pass a valid API key.') });
      await expect(h.processor.process('p1', false)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(h.photo.status).toBe('FAILED');
    });
  });
});
