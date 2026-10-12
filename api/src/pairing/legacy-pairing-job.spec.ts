import { handleLegacyPairingJob } from './legacy-pairing-job';

function prisma(opts: { wine?: unknown; producerWines?: unknown[] } = {}) {
  return {
    wine: {
      findUnique: jest.fn(async () => ('wine' in opts ? opts.wine : { id: 'w1' })),
      findMany: jest.fn(async () => opts.producerWines ?? [{ producer: 'Domaine Tempier', appellationRaw: 'Bandol', appellation: null }]),
    },
    pairing: { createMany: jest.fn(async () => ({ count: 1 })) },
    producerProfile: { createMany: jest.fn(async () => ({ count: 1 })) },
  };
}

describe('handleLegacyPairingJob — travaux BullMQ de la version précédente', () => {
  it('« pairing » : s’assure que la demande du vin existe en attente, sans jamais appeler Gemini', async () => {
    const p = prisma();
    await handleLegacyPairingJob(p as any, { name: 'pairing', data: { wineId: 'w1' } });
    expect(p.pairing.createMany).toHaveBeenCalledWith({ data: [{ wineId: 'w1', requestedAt: expect.any(Date) }], skipDuplicates: true });
    // Aucun fournisseur n'est seulement accessible à cette fonction : elle ne reçoit que la base.
    expect(handleLegacyPairingJob.length).toBe(2);
  });

  it('« pairing » d’un vin supprimé depuis : rien à faire, le travail aboutit', async () => {
    const p = prisma({ wine: null });
    await expect(handleLegacyPairingJob(p as any, { name: 'pairing', data: { wineId: 'w1' } })).resolves.toBeUndefined();
    expect(p.pairing.createMany).not.toHaveBeenCalled();
  });

  it('« producer » : s’assure que le descriptif du domaine existe en attente', async () => {
    const p = prisma();
    await handleLegacyPairingJob(p as any, { name: 'producer', data: { producerKey: 'domaine tempier' } });
    expect(p.producerProfile.createMany).toHaveBeenCalledWith({
      data: [{ producerKey: 'domaine tempier', displayName: 'Domaine Tempier', requestedAt: expect.any(Date) }],
      skipDuplicates: true,
    });
  });

  it('« producer » d’un domaine sans plus aucun vin, ou travail illisible : rien à faire', async () => {
    const p = prisma({ producerWines: [] });
    await handleLegacyPairingJob(p as any, { name: 'producer', data: { producerKey: 'domaine tempier' } });
    await handleLegacyPairingJob(p as any, { name: 'autre', data: {} });
    expect(p.producerProfile.createMany).not.toHaveBeenCalled();
    expect(p.pairing.createMany).not.toHaveBeenCalled();
  });
});
