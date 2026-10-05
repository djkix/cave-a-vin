import { VisionBudgetExceededError, VisionBudgetService } from './vision-budget.service';

describe('VisionBudgetService', () => {
  const prismaWith = (sum: number | null, pairingSum: number | null = null) => ({
    photo: { aggregate: async () => ({ _sum: { costCents: sum } }) },
    pairing: { aggregate: jest.fn(async () => ({ _sum: { costCents: pairingSum } })) },
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
});
