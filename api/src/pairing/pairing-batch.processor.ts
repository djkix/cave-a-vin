import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VisionBudgetService } from '../queue/vision-budget.service';
import { GeminiJournal } from '../vision/gemini-journal';
import { PAIRING_PROVIDER, PairingProvider, PairingWine } from '../vision/pairing-provider.interface';
import { BatchAnswer, GenerationBatchProcessor, Prepared, QueueTable, ReservedRequest } from './generation-batch.processor';

/**
 * Accords mets-vins par lots de dix vins au plus (voir GenerationBatchProcessor).
 * La ligne `pairing` d'un vin supprimé disparaît avec lui (cascade) : rien à régler.
 */
@Injectable()
export class PairingBatchProcessor extends GenerationBatchProcessor<PairingWine, { dishes: string[] }> {
  protected readonly logger = new Logger(PairingBatchProcessor.name);
  protected readonly label = 'Accords';
  protected readonly tableName = 'pairing';

  constructor(
    prisma: PrismaService,
    @Inject(PAIRING_PROVIDER) private readonly provider: PairingProvider,
    budget: VisionBudgetService,
    pause: GeminiJournal,
  ) {
    super(prisma, budget, pause);
  }

  protected table(db: Prisma.TransactionClient = this.prisma): QueueTable {
    return db.pairing as unknown as QueueTable;
  }

  protected async prepare(requests: ReservedRequest[]): Promise<Array<Prepared<PairingWine>>> {
    const rows = await this.prisma.pairing.findMany({
      where: { id: { in: requests.map((r) => r.id) } },
      select: {
        id: true,
        wine: {
          select: { producer: true, cuvee: true, appellationRaw: true, color: true, vintage: true, appellation: { select: { canonicalName: true, region: true } } },
        },
      },
    });
    const wineOf = new Map(rows.map((r) => [r.id, r.wine]));
    return requests.flatMap((request) => {
      const wine = wineOf.get(request.id);
      if (!wine) return [];
      const input: PairingWine = {
        producer: wine.producer,
        cuvee: wine.cuvee,
        appellation: wine.appellation?.canonicalName ?? wine.appellationRaw,
        region: wine.appellation?.region ?? null,
        color: wine.color,
        vintage: wine.vintage,
      };
      // Même producteur, cuvée, appellation, couleur et millésime : une seule ligne dans l'appel.
      return [{ request, input, dedupKey: JSON.stringify([input.producer, input.cuvee, input.appellation, input.color, input.vintage]) }];
    });
  }

  protected generate(wines: PairingWine[]): Promise<BatchAnswer<{ dishes: string[] }>> {
    return this.provider.suggestPairingsBatch(wines);
  }

  protected async save(request: ReservedRequest, item: { dishes: string[] }, meta: { model: string; costCents: number }, deadline: Date): Promise<void> {
    await this.prisma.pairing.updateMany({
      where: { id: request.id, reservedUntil: deadline },
      data: {
        status: 'DONE',
        dishes: item.dishes,
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
