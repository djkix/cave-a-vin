import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const VISION_MONTHLY_CAP_CENTS = 'VISION_MONTHLY_CAP_CENTS';

/** Les accords et les descriptifs de domaine ne tournent que sous 80 % du plafond : les photos gardent toujours de la marge. */
export const PAIRING_BUDGET_SHARE = 0.8;

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

  /** Photos, accords, descriptifs de domaine et recherches d'image du mois : un seul plafond pour toute la dépense Gemini. */
  async spentThisMonthCents(): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const [photos, pairings, producers, imageSearches] = await Promise.all([
      this.prisma.photo.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start } } }),
      this.prisma.pairing.aggregate({ _sum: { costCents: true }, where: { generatedAt: { gte: start } } }),
      this.prisma.producerProfile.aggregate({ _sum: { costCents: true }, where: { generatedAt: { gte: start } } }),
      this.prisma.imageSearchCost.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start } } }),
    ]);
    return (
      (photos._sum.costCents ?? 0) + (pairings._sum.costCents ?? 0) + (producers._sum.costCents ?? 0) + (imageSearches._sum.costCents ?? 0)
    );
  }

  async assertUnderCap(): Promise<void> {
    return this.assertUnderShare(1);
  }

  /** `share` = 1 pour le plafond complet (photos), `PAIRING_BUDGET_SHARE` pour les accords. */
  async assertUnderShare(share: number): Promise<void> {
    if ((await this.spentThisMonthCents()) >= this.capCents * share) throw new VisionBudgetExceededError();
  }
}
