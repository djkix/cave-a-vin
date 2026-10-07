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

  /** Rapproche ou crée le vin dans la cave `caveId` : deux caves ne partagent jamais une fiche. */
  async matchOrCreate(caveId: string, draft: WineDraft): Promise<{ wine: Wine; created: boolean; appellation: AppellationMatch }> {
    const appellation = await this.appellations.resolve(draft.appellationRaw);
    // Seule une correspondance `exact` (similarité >= 0,8) autorise à réécrire le
    // libellé : un `fuzzy` (0,5–0,8) rattache le vin à l'appellation sans jamais
    // remplacer silencieusement ce que l'étiquette dit.
    const appellationRaw = appellation.kind === 'exact' ? appellation.canonicalName : draft.appellationRaw.trim();
    const matchKey = computeMatchKey({ ...draft, appellationRaw });

    const existing = await this.prisma.wine.findUnique({ where: { caveId_matchKey: { caveId, matchKey } } });
    if (existing) return { wine: existing, created: false, appellation };

    try {
      const wine = await this.prisma.wine.create({
        data: {
          caveId,
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
        const raced = await this.prisma.wine.findUnique({ where: { caveId_matchKey: { caveId, matchKey } } });
        if (raced) return { wine: raced, created: false, appellation };
      }
      throw e;
    }
  }
}
