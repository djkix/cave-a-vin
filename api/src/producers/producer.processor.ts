import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { deferralReason, isTransientVisionFailure } from '../queue/transient-failure';
import { PAIRING_BUDGET_SHARE, VisionBudgetService } from '../queue/vision-budget.service';
import { ProducerInvalidOutputError } from '../vision/producer-output';
import { PRODUCER_PROVIDER, ProducerProvider } from '../vision/producer-provider.interface';
import { findProducerWines } from './producer-wines';

/** Une réponse mal formée n'est pas une erreur de configuration (clé refusée, droits) : on les distingue. */
function definitiveReason(e: unknown): string {
  return e instanceof ProducerInvalidOutputError ? 'Réponse de Gemini inexploitable' : 'Génération impossible : configuration Gemini à vérifier';
}

@Injectable()
export class ProducerProcessor {
  private readonly logger = new Logger(ProducerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRODUCER_PROVIDER) private readonly provider: ProducerProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async process(producerKey: string, isLastAttempt = true): Promise<void> {
    const wines = await findProducerWines(this.prisma, producerKey);
    if (!wines.length) return; // plus aucun vin de ce domaine depuis la mise en file
    const existing = await this.prisma.producerProfile.findUnique({ where: { producerKey } });
    if (existing?.source === 'MANUEL') return; // la version saisie à la main prime toujours
    await this.prisma.producerProfile.upsert({
      where: { producerKey },
      create: { producerKey, displayName: wines[0].producer },
      update: {},
    });
    // Chaque écriture exige source = GEMINI : un texte saisi pendant la génération n'est jamais écrasé.
    const save = (data: Record<string, unknown>) =>
      this.prisma.producerProfile.updateMany({ where: { producerKey, source: 'GEMINI' }, data });
    try {
      await this.budget.assertUnderShare(PAIRING_BUDGET_SHARE);
      const appellations = [...new Set(wines.map((w) => w.appellation?.canonicalName ?? w.appellationRaw))];
      const region = wines.find((w) => w.appellation?.region)?.appellation?.region ?? null;
      const result = await this.provider.describeProducer({ producer: wines[0].producer, appellations, region });
      await save({
        status: result.known ? 'DONE' : 'UNKNOWN',
        description: result.known ? result.description : null,
        model: result.model,
        costCents: result.costCents,
        errorMessage: null,
        generatedAt: new Date(),
      });
    } catch (e) {
      const transient = isTransientVisionFailure(e);
      this.logger.warn(`Descriptif « ${producerKey} » ${transient ? 'reporté' : 'en échec'} : ${e instanceof Error ? e.message : String(e)}`);
      if (transient && !isLastAttempt) {
        await save({ status: 'PENDING', errorMessage: deferralReason(e) });
        throw e;
      }
      await save({ status: 'FAILED', errorMessage: transient ? `${deferralReason(e)} — abandon` : definitiveReason(e) });
      throw transient ? e : new UnrecoverableError(e instanceof Error ? e.message : String(e));
    }
  }
}
