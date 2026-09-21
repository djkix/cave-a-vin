import { ExtractionProcessor } from './extraction.processor';

function harness(opts: { visionFails?: boolean } = {}) {
  const photo: any = { id: 'p1', status: 'PENDING' };
  const prisma = { photo: { update: jest.fn(async ({ data }: any) => Object.assign(photo, data)) } };
  const photos = { readNormalized: jest.fn(async () => Buffer.from('img')) };
  const vision = {
    extractWineLabel: jest.fn(async () => {
      if (opts.visionFails) throw new Error('boom');
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

  it('marks FAILED with the message and rethrows so BullMQ retries', async () => {
    const h = harness({ visionFails: true });
    await expect(h.processor.process('p1')).rejects.toThrow('boom');
    expect(h.photo.status).toBe('FAILED');
    expect(h.photo.errorMessage).toBe('boom');
  });

  it('checks the budget before calling the model', async () => {
    const h = harness();
    h.budget.assertUnderCap.mockRejectedValueOnce(new Error('cap'));
    await expect(h.processor.process('p1')).rejects.toThrow('cap');
    expect(h.vision.extractWineLabel).not.toHaveBeenCalled();
  });

  it('keeps status PROCESSING (not FAILED) on a non-final attempt, but still rethrows so BullMQ retries', async () => {
    const h = harness({ visionFails: true });
    await expect(h.processor.process('p1', false)).rejects.toThrow('boom');
    expect(h.photo.status).toBe('PROCESSING');
    expect(h.photo.errorMessage).toBe('boom');
  });
});
