import { NotFoundException } from '@nestjs/common';
import { PairingScheduler, PairingService } from './pairing.service';

function harness(opts: { wine?: unknown } = {}) {
  const upsert = jest.fn(async () => ({}));
  const createMany = jest.fn(async () => ({ count: 1 }));
  const prisma = {
    // Le vin n'existe que dans la cave c1.
    wine: { findFirst: jest.fn(async ({ where }: any) => ('wine' in opts ? opts.wine : where.caveId === 'c1' && where.id === 'w1' ? { id: 'w1' } : null)) },
    pairing: { upsert, createMany },
  };
  return { upsert, createMany, prisma, service: new PairingService(prisma as any) };
}

describe('PairingService.regenerate', () => {
  it('remet l’accord en attente tout de suite, daté de maintenant, tentatives remises à zéro, réservation d’un lot en cours levée : il part dans le lot suivant, sans appel à Gemini', async () => {
    const h = harness();
    const before = Date.now();
    await h.service.regenerate('c1', 'w1');
    expect(h.upsert).toHaveBeenCalledWith({
      where: { wineId: 'w1' },
      create: { wineId: 'w1', requestedAt: expect.any(Date) },
      update: { status: 'PENDING', errorMessage: null, requestedAt: expect.any(Date), attempts: 0, nextAttemptAt: null, reservedUntil: null },
    });
    const { update } = (h.upsert.mock.calls[0] as any)[0];
    expect(update.requestedAt.getTime()).toBeGreaterThanOrEqual(before);
    // Le service ne dépend que de la base : aucun fournisseur Gemini, aucune file.
    expect(PairingService.length).toBe(1);
  });

  it('vin d’une autre cave : 404 « Vin introuvable », rien n’est remis en attente', async () => {
    const h = harness();
    await expect(h.service.regenerate('c2', 'w1')).rejects.toThrow(new NotFoundException('Vin introuvable'));
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('refuse un vin introuvable', async () => {
    const h = harness({ wine: null });
    await expect(h.service.regenerate('c1', 'w1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PairingScheduler.schedule', () => {
  it('nouveau vin : crée sa demande d’accords en attente, sans toucher à une ligne existante', async () => {
    const h = harness();
    await new PairingScheduler(h.prisma as any).schedule('w1');
    expect(h.createMany).toHaveBeenCalledWith({ data: [{ wineId: 'w1', requestedAt: expect.any(Date) }], skipDuplicates: true });
  });
});
