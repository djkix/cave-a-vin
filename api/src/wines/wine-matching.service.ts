import { Injectable } from '@nestjs/common';
import { Prisma, Wine } from '@prisma/client';
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

    try {
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
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.wine.findUnique({ where: { matchKey } });
        if (raced) return { wine: raced, created: false, appellation };
      }
      throw e;
    }
  }
}
