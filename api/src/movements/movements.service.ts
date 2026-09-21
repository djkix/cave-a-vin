import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Movement, Wine } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WineMatchingService } from '../wines/wine-matching.service';
import { CreateMovementInput } from './dto';

export interface MovementResult {
  movement: Movement;
  wine: Wine;
  stock: number;
  created: boolean;
}

@Injectable()
export class MovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: WineMatchingService,
  ) {}

  async stockOf(wineId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock_courant WHERE wine_id = ${wineId}`;
    return rows[0]?.quantity ?? 0;
  }

  async createIn(input: CreateMovementInput): Promise<MovementResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité doit être un entier positif');
    }
    const existing = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } });
    if (existing) return { movement: existing, wine: existing.wine, stock: await this.stockOf(existing.wineId), created: false };

    const { wine } = await this.matching.matchOrCreate(input.wine);
    const movement = await this.prisma.movement.create({
      data: {
        wineId: wine.id,
        delta: input.quantity,
        type: 'IN',
        photoId: input.photoId ?? null,
        priceUnitCents: input.priceUnitCents ?? null,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { movement, wine, stock: await this.stockOf(wine.id), created: true };
  }

  async cancel(movementId: string, idempotencyKey: string): Promise<MovementResult> {
    const already = await this.prisma.movement.findUnique({ where: { idempotencyKey }, include: { wine: true } });
    if (already) return { movement: already, wine: already.wine, stock: await this.stockOf(already.wineId), created: false };

    const original = await this.prisma.movement.findUnique({ where: { id: movementId }, include: { wine: true } });
    if (!original) throw new NotFoundException('Mouvement introuvable');
    const reversal = await this.prisma.movement.findFirst({ where: { reversesId: movementId } });
    if (reversal) throw new ConflictException('Ce mouvement a déjà été annulé');

    try {
      const movement = await this.prisma.movement.create({
        data: {
          wineId: original.wineId,
          delta: -original.delta,
          type: 'ADJUST',
          note: `Annulation du mouvement ${original.id}`,
          idempotencyKey,
          reversesId: original.id,
        },
      });
      return { movement, wine: original.wine, stock: await this.stockOf(original.wineId), created: true };
    } catch (e) {
      if (e instanceof Error && /aucune bouteille/.test(e.message)) {
        throw new ConflictException('Impossible d’annuler : il ne reste aucune bouteille de ce vin');
      }
      throw e;
    }
  }

  recent(limit = 20): Promise<Array<Movement & { wine: Wine }>> {
    return this.prisma.movement.findMany({ take: limit, orderBy: { occurredAt: 'desc' }, include: { wine: true } });
  }
}
