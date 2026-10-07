import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateQuoteInput, QUOTE_SELECT, QuoteView, quoteView } from './quote';

/** Cotes iDealwine saisies à la main : ajout seulement (l'historique est gardé). */
@Injectable()
export class QuotesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ajoute une cote à un vin de la cave ; un vin d'une autre cave est « introuvable », comme un identifiant inconnu. */
  async create(caveId: string, wineId: string, input: CreateQuoteInput, userId: string): Promise<QuoteView> {
    const wine = await this.prisma.wine.findFirst({ where: { id: wineId, caveId }, select: { id: true } });
    if (!wine) throw new NotFoundException('Vin introuvable');
    const created = await this.prisma.priceQuote.create({
      data: {
        wineId,
        coteCents: input.coteCents,
        nTransactions: input.nTransactions ?? null,
        quotedOn: new Date(`${input.quotedOn}T00:00:00Z`),
        sourceUrl: input.sourceUrl ?? null,
        enteredById: userId,
      },
      select: QUOTE_SELECT,
    });
    return quoteView(created);
  }
}
