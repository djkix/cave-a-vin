import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { deferralReason, isTransientVisionFailure } from '../queue/transient-failure';
import { GeminiPausedError } from '../vision/gemini-pause';
import { PAIRING_BUDGET_SHARE, VisionBudgetService } from '../queue/vision-budget.service';
import { PairingInvalidOutputError } from '../vision/pairing-output';
import { PAIRING_PROVIDER, PairingProvider } from '../vision/pairing-provider.interface';

/** Une réponse mal formée n'est pas une erreur de configuration (clé refusée, droits) : on les distingue. */
function definitiveReason(e: unknown): string {
  return e instanceof PairingInvalidOutputError ? 'Réponse de Gemini inexploitable' : 'Génération impossible : configuration Gemini à vérifier';
}

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
      await this.budget.assertUnderShare(PAIRING_BUDGET_SHARE);
      const result = await this.provider.suggestPairings({
        producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellation?.canonicalName ?? wine.appellationRaw,
        region: wine.appellation?.region ?? null, color: wine.color, vintage: wine.vintage,
      });
      await this.prisma.pairing.update({
        where: { wineId },
        data: { status: 'DONE', dishes: result.dishes, model: result.model, costCents: result.costCents, errorMessage: null, generatedAt: new Date() },
      });
    } catch (e) {
      // Pause commune de Gemini : aucun appel n'est parti. En attente avec le
      // message de la pause, même au dernier essai ; le travail est reporté
      // après la pause sans consommer de tentative (wine-pairing-dispatch).
      if (e instanceof GeminiPausedError) {
        await this.prisma.pairing.update({ where: { wineId }, data: { status: 'PENDING', errorMessage: deferralReason(e) } });
        throw e;
      }
      const transient = isTransientVisionFailure(e);
      this.logger.warn(`Accords ${wineId} ${transient ? 'reportés' : 'en échec'} : ${e instanceof Error ? e.message : String(e)}`);
      if (transient && !isLastAttempt) {
        await this.prisma.pairing.update({ where: { wineId }, data: { status: 'PENDING', errorMessage: deferralReason(e) } });
        throw e;
      }
      await this.prisma.pairing.update({
        where: { wineId },
        data: { status: 'FAILED', errorMessage: transient ? `${deferralReason(e)} — abandon` : definitiveReason(e) },
      });
      throw transient ? e : new UnrecoverableError(e instanceof Error ? e.message : String(e));
    }
  }
}
