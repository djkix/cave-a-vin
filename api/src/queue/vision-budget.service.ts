import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const VISION_MONTHLY_CAP_CENTS = 'VISION_MONTHLY_CAP_CENTS';

export class VisionBudgetExceededError extends Error {
  constructor() {
    super('Plafond mensuel de dépense vision atteint — saisie manuelle uniquement jusqu’au mois prochain');
  }
}

@Injectable()
export class VisionBudgetService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(VISION_MONTHLY_CAP_CENTS) private readonly capCents: number,
  ) {}

  async spentThisMonthCents(): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const agg = await this.prisma.photo.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start } } });
    return agg._sum.costCents ?? 0;
  }

  async assertUnderCap(): Promise<void> {
    if ((await this.spentThisMonthCents()) >= this.capCents) throw new VisionBudgetExceededError();
  }
}
