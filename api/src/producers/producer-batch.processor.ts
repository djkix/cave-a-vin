import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BatchAnswer, GenerationBatchProcessor, Prepared, QueueTable, QueueWhere, ReservedRequest } from '../pairing/generation-batch.processor';
import { PrismaService } from '../prisma/prisma.service';
import { VisionBudgetService } from '../queue/vision-budget.service';
import { GeminiJournal } from '../vision/gemini-journal';
import { PRODUCER_PROVIDER, ProducerProvider, ProducerQuery } from '../vision/producer-provider.interface';
import { findWinesByProducer } from './producer-wines';

type Description = { known: boolean; description: string | null };

/**
 * Descriptifs de domaine par lots de dix domaines au plus (voir
 * GenerationBatchProcessor). Seuls les descriptifs Gemini sont dans la file :
 * chaque lecture et écriture exige source = GEMINI, un texte saisi à la main
 * (même pendant la génération) n'est jamais écrasé.
 */
@Injectable()
export class ProducerBatchProcessor extends GenerationBatchProcessor<ProducerQuery, Description> {
  protected readonly logger = new Logger(ProducerBatchProcessor.name);
  protected readonly label = 'Descriptifs';
  protected readonly tableName = 'producer_profile';
  protected readonly scope: QueueWhere = { source: 'GEMINI' };
  protected readonly scopeSql = Prisma.sql`AND source = 'GEMINI'`;

  constructor(
    prisma: PrismaService,
    @Inject(PRODUCER_PROVIDER) private readonly provider: ProducerProvider,
    budget: VisionBudgetService,
    pause: GeminiJournal,
  ) {
    super(prisma, budget, pause);
  }

  protected table(db: Prisma.TransactionClient = this.prisma): QueueTable {
    return db.producerProfile as unknown as QueueTable;
  }

  /**
   * Un domaine qui n'a plus aucun vin (tous supprimés depuis la demande) n'a
   * plus de descriptif à générer : sa demande est retirée, elle sera recréée
   * à l'entrée d'un nouveau vin de ce domaine.
   */
  protected async prepare(requests: ReservedRequest[], deadline: Date): Promise<Array<Prepared<ProducerQuery>>> {
    const rows = await this.prisma.producerProfile.findMany({ where: { id: { in: requests.map((r) => r.id) } }, select: { id: true, producerKey: true } });
    const keyOf = new Map(rows.map((r) => [r.id, r.producerKey]));
    const winesOf = await findWinesByProducer(this.prisma, rows.map((r) => r.producerKey));
    const prepared: Array<Prepared<ProducerQuery>> = [];
    for (const request of requests) {
      const wines = winesOf.get(keyOf.get(request.id) ?? '') ?? [];
      if (!wines.length) {
        await this.prisma.producerProfile.deleteMany({ where: { id: request.id, source: 'GEMINI', status: 'PENDING', reservedUntil: deadline } });
        continue;
      }
      prepared.push({
        request,
        input: {
          producer: wines[0].producer,
          appellations: [...new Set(wines.map((w) => w.appellation?.canonicalName ?? w.appellationRaw))],
          region: wines.find((w) => w.appellation?.region)?.appellation?.region ?? null,
        },
      });
    }
    return prepared;
  }

  protected generate(queries: ProducerQuery[]): Promise<BatchAnswer<Description>> {
    return this.provider.describeProducersBatch(queries);
  }

  protected async save(request: ReservedRequest, item: Description, meta: { model: string; costCents: number }, deadline: Date): Promise<void> {
    await this.prisma.producerProfile.updateMany({
      where: { id: request.id, source: 'GEMINI', reservedUntil: deadline },
      data: {
        status: item.known ? 'DONE' : 'UNKNOWN',
        description: item.known ? item.description : null,
        model: meta.model,
        costCents: meta.costCents,
        errorMessage: null,
        generatedAt: new Date(),
        attempts: 0,
        nextAttemptAt: null,
        reservedUntil: null,
      },
    });
  }
}
