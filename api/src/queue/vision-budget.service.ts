import { Inject, Injectable } from '@nestjs/common';
import { mainCaveId } from '../caves/main-cave';
import { PrismaService } from '../prisma/prisma.service';

export const VISION_MONTHLY_CAP_CENTS = 'VISION_MONTHLY_CAP_CENTS';

/** Les accords et les descriptifs de domaine ne tournent que sous 80 % du plafond : les photos gardent toujours de la marge. */
export const PAIRING_BUDGET_SHARE = 0.8;

/** Réglage `app_setting` de la part maximale du plafond qu'une cave peut dépenser. */
export const CAVE_BUDGET_SHARE_KEY = 'cave_budget_share';

/** Part par cave quand le réglage manque (ou est illisible). */
export const DEFAULT_CAVE_BUDGET_SHARE = 0.2;

export class VisionBudgetExceededError extends Error {
  constructor(message = 'Plafond mensuel de dépense vision atteint — saisie manuelle uniquement jusqu’au mois prochain') {
    super(message);
  }
}

/**
 * Part mensuelle d'une cave atteinte. C'est un report de plafond comme un autre
 * (même classe de base) : chaque appelant le traite exactement comme le plafond
 * global (photo reportée, jamais perdue ; 503 pour la recherche d'image).
 */
export class CaveBudgetShareExceededError extends VisionBudgetExceededError {
  constructor() {
    super('Part mensuelle de cette cave atteinte — reprise le mois prochain');
  }
}

function startOfMonth(): Date {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

@Injectable()
export class VisionBudgetService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(VISION_MONTHLY_CAP_CENTS) readonly capCents: number,
  ) {}

  /**
   * Sans cave : photos, accords, descriptifs de domaine et recherches d'image du
   * mois — un seul plafond pour toute la dépense Gemini.
   *
   * Avec une cave : seulement ce qui lui est attribuable — ses photos (lectures
   * d'entrée, parts de lot et analyses de sortie, cumulées sur la photo), ses
   * recherches d'image et les accords de ses vins. Les descriptifs de domaine,
   * communs à toutes les caves, n'entrent pas dans la part d'une cave.
   */
  async spentThisMonthCents(caveId?: string): Promise<number> {
    const start = startOfMonth();
    if (caveId !== undefined) {
      const [photos, pairings, imageSearches] = await Promise.all([
        this.prisma.photo.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start }, caveId } }),
        this.prisma.pairing.aggregate({ _sum: { costCents: true }, where: { generatedAt: { gte: start }, wine: { caveId } } }),
        this.prisma.imageSearchCost.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: start }, caveId } }),
      ]);
      return (photos._sum.costCents ?? 0) + (pairings._sum.costCents ?? 0) + (imageSearches._sum.costCents ?? 0);
    }
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

  /** Part du plafond qu'une cave peut dépenser (0 à 1) ; 0,2 si le réglage manque ou est illisible. */
  async caveShare(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: CAVE_BUDGET_SHARE_KEY } });
    if (!row || row.value.trim() === '') return DEFAULT_CAVE_BUDGET_SHARE;
    const share = Number(row.value);
    return Number.isFinite(share) && share >= 0 && share <= 1 ? share : DEFAULT_CAVE_BUDGET_SHARE;
  }

  async setCaveShare(share: number): Promise<void> {
    const value = String(share);
    await this.prisma.appSetting.upsert({
      where: { key: CAVE_BUDGET_SHARE_KEY },
      create: { key: CAVE_BUDGET_SHARE_KEY, value },
      update: { value },
    });
  }

  /** Cave de l'administrateur principal, exemptée de la part par cave (voir mainCaveId). */
  exemptCaveId(): Promise<string | null> {
    return mainCaveId(this.prisma);
  }

  /**
   * En plus du plafond global : une cave (sauf celle du premier administrateur)
   * ne dépense pas plus de `plafond × part` dans le mois.
   */
  async assertCaveUnderShare(caveId: string): Promise<void> {
    if ((await this.exemptCaveId()) === caveId) return;
    const [share, spent] = await Promise.all([this.caveShare(), this.spentThisMonthCents(caveId)]);
    if (spent >= this.capCents * share) throw new CaveBudgetShareExceededError();
  }
}
