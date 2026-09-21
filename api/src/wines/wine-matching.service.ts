import { Injectable } from '@nestjs/common';
import { Wine } from '@prisma/client';
import { AppellationMatch, AppellationsService } from '../appellations/appellations.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeMatchKey, WineDraft } from './match-key';

@Injectable()
export class WineMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appellations: AppellationsService,
  ) {}

  async matchOrCreate(draft: WineDraft): Promise<{ wine: Wine; created: boolean; appellation: AppellationMatch }> {
    const appellation = await this.appellations.resolve(draft.appellationRaw);
    const appellationRaw = appellation.kind === 'none' ? draft.appellationRaw.trim() : appellation.canonicalName;
    const matchKey = computeMatchKey({ ...draft, appellationRaw });

    const existing = await this.prisma.wine.findUnique({ where: { matchKey } });
    if (existing) return { wine: existing, created: false, appellation };

    const wine = await this.prisma.wine.create({
      data: {
        matchKey,
        producer: draft.producer.trim(),
        cuvee: draft.cuvee?.trim() || null,
        appellationId: appellation.kind === 'none' ? null : appellation.id,
        appellationRaw,
        vintage: draft.vintage ?? null,
        color: draft.color,
        formatCl: draft.formatCl,
      },
    });
    return { wine, created: true, appellation };
  }
}
