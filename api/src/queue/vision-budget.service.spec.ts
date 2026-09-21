import { VisionBudgetExceededError, VisionBudgetService } from './vision-budget.service';

describe('VisionBudgetService', () => {
  const prismaWith = (sum: number | null) => ({ photo: { aggregate: async () => ({ _sum: { costCents: sum } }) } });

  it('passes when under the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(120) as any, 500).assertUnderCap()).resolves.toBeUndefined();
  });

  it('throws when the monthly sum reaches the cap', async () => {
    await expect(new VisionBudgetService(prismaWith(500) as any, 500).assertUnderCap()).rejects.toBeInstanceOf(VisionBudgetExceededError);
  });
});
