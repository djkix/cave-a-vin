import { PAIRING_BUDGET_SHARE, VisionBudgetExceededError, VisionBudgetService } from './vision-budget.service';

describe('VisionBudgetService', () => {
  const prismaWith = (sum: number | null, pairingSum: number | null = null, producerSum: number | null = null, imageSearchSum: number | null = null) => ({
    photo: { aggregate: async () => ({ _sum: { costCents: sum } }) },
    pairing: { aggregate: jest.fn(async () => ({ _sum: { costCents: pairingSum } })) },
    producerProfile: { aggregate: jest.fn(async () => ({ _sum: { costCents: producerSum } })) },
    imageSearchCost: { aggregate: jest.fn(async () => ({ _sum: { costCents: imageSearchSum } })) },
  });

  it('passes when under the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(120) as any, 500).assertUnderCap()).resolves.toBeUndefined();
  });

  it('throws when the monthly sum reaches the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(500) as any, 500).assertUnderCap()).rejects.toBeInstanceOf(VisionBudgetExceededError);
  });

  it('additionne les photos et les accords du mois', async () => {
    const prisma = prismaWith(30, 12);
    await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(42);
    expect(prisma.pairing.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { generatedAt: { gte: expect.any(Date) } } });
  });

  it('compte aussi les descriptifs de domaine générés dans le mois', async () => {
    const prisma = prismaWith(30, 12, 5);
    await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(47);
    expect(prisma.producerProfile.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { generatedAt: { gte: expect.any(Date) } } });
  });

  it('compte aussi les recherches d’image du mois (site officiel trouvé par Gemini)', async () => {
    const prisma = prismaWith(30, 12, 5, 3);
    await expect(new VisionBudgetService(prisma as any, 500).spentThisMonthCents()).resolves.toBe(50);
    expect(prisma.imageSearchCost.aggregate).toHaveBeenCalledWith({ _sum: { costCents: true }, where: { createdAt: { gte: expect.any(Date) } } });
  });

  describe('assertUnderShare', () => {
    it('passe sous 80 % du plafond (79 %)', async () => {
      await expect(new VisionBudgetService(prismaWith(395) as any, 500).assertUnderShare(PAIRING_BUDGET_SHARE)).resolves.toBeUndefined();
    });

    it('lève une erreur à 80 % du plafond, pour garder de la marge aux photos', async () => {
      await expect(new VisionBudgetService(prismaWith(400) as any, 500).assertUnderShare(PAIRING_BUDGET_SHARE)).rejects.toBeInstanceOf(VisionBudgetExceededError);
    });

    it('assertUnderCap reste équivalent à une part de 100 %', async () => {
      await expect(new VisionBudgetService(prismaWith(500) as any, 500).assertUnderShare(1)).rejects.toBeInstanceOf(VisionBudgetExceededError);
      await expect(new VisionBudgetService(prismaWith(499) as any, 500).assertUnderShare(1)).resolves.toBeUndefined();
    });
  });
});
