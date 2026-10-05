import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { deferralReason, isTransientVisionFailure } from '../queue/transient-failure';
import { VisionBudgetService } from '../queue/vision-budget.service';
import { PAIRING_PROVIDER, PairingProvider } from '../vision/pairing-provider.interface';

@Injectable()
export class PairingProcessor {
  private readonly logger = new Logger(PairingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAIRING_PROVIDER) private readonly provider: PairingProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async process(wineId: string, isLastAttempt = true): Promise<void> {
    const wine = await this.prisma.wine.findUnique({ where: { id: wineId }, include: { appellation: true } });
    if (!wine) return; // vin supprimé depuis la mise en file
    await this.prisma.pairing.upsert({ where: { wineId }, create: { wineId }, update: {} });
    try {
      await this.budget.assertUnderCap();
      const result = await this.provider.suggestPairings({
        producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellation?.canonicalName ?? wine.appellationRaw,
        region: wine.appellation?.region ?? null, color: wine.color, vintage: wine.vintage,
      });
      await this.prisma.pairing.update({
        where: { wineId },
        data: { status: 'DONE', dishes: result.dishes, model: result.model, costCents: result.costCents, errorMessage: null, generatedAt: new Date() },
      });
    } catch (e) {
      const transient = isTransientVisionFailure(e);
      this.logger.warn(`Accords ${wineId} ${transient ? 'reportés' : 'en échec'} : ${e instanceof Error ? e.message : String(e)}`);
      if (transient && !isLastAttempt) {
        await this.prisma.pairing.update({ where: { wineId }, data: { status: 'PENDING', errorMessage: deferralReason(e) } });
        throw e;
      }
      await this.prisma.pairing.update({
        where: { wineId },
        data: { status: 'FAILED', errorMessage: transient ? `${deferralReason(e)} — abandon` : 'Réponse de Gemini inexploitable' },
      });
      throw transient ? e : new UnrecoverableError(e instanceof Error ? e.message : String(e));
    }
  }
}
