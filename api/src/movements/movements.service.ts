import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Movement, Prisma, Wine } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WineMatchingService } from '../wines/wine-matching.service';
import { CreateMovementInput, CreateOutInput, InventoryInput } from './dto';

export interface MovementResult {
  movement: Movement;
  wine: Wine;
  stock: number;
  created: boolean;
}

export interface InventoryResult {
  movement: Movement | null;
  stock: number;
  delta: number;
  created: boolean;
}

// A racing replay (offline-queue flush, double tap) can lose the findUnique-then-create
// race to another request: the unique index throws P2002 instead of the pre-check
// catching it. `target` distinguishes which unique constraint fired.
function isUniqueViolation(e: unknown, target: string): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String(e.meta?.target ?? '').includes(target);
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
    if (existing) {
      const { wine, ...movement } = existing;
      return { movement, wine, stock: await this.stockOf(existing.wineId), created: false };
    }

    const { wine } = await this.matching.matchOrCreate(input.wine);
    try {
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
      // La première photo d'entrée devient la vignette du vin : c'est elle qui
      // permet de départager deux millésimes à la sortie.
      if (input.photoId && !wine.referencePhotoId) {
        // updateMany (et non update) : la condition referencePhotoId: null est
        // vérifiée par la base au moment de l'écriture, pas seulement par la
        // valeur lue en mémoire. Deux premières entrées concurrentes ne gagnent
        // donc pas toutes les deux — la seconde ne modifie plus aucune ligne.
        await this.prisma.wine.updateMany({ where: { id: wine.id, referencePhotoId: null }, data: { referencePhotoId: input.photoId } });
      }

      return { movement, wine, stock: await this.stockOf(wine.id), created: true };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency')) {
        const raced = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } });
        if (raced) {
          const { wine: racedWine, ...movement } = raced;
          return { movement, wine: racedWine, stock: await this.stockOf(raced.wineId), created: false };
        }
      }
      // Une photo ne crédite le stock qu'une fois (index partiel idx_movement_photo_in) :
      // une seconde confirmation de la même photo — deux téléphones, ou un envoi en
      // double qui ramène sur une fiche déjà validée — renvoie le premier mouvement.
      if (isUniqueViolation(e, 'photo')) {
        const already = await this.prisma.movement.findFirst({
          where: { photoId: input.photoId ?? null, type: 'IN' },
          include: { wine: true },
        });
        if (already) {
          const { wine: alreadyWine, ...movement } = already;
          return { movement, wine: alreadyWine, stock: await this.stockOf(already.wineId), created: false };
        }
      }
      throw e;
    }
  }

  async cancel(movementId: string, idempotencyKey: string): Promise<MovementResult> {
    const already = await this.prisma.movement.findUnique({ where: { idempotencyKey }, include: { wine: true } });
    if (already) {
      const { wine, ...movement } = already;
      return { movement, wine, stock: await this.stockOf(already.wineId), created: false };
    }

    const original = await this.prisma.movement.findUnique({ where: { id: movementId }, include: { wine: true } });
    if (!original) throw new NotFoundException('Mouvement introuvable');
    if (original.reversesId) throw new ConflictException('Une annulation ne peut pas être annulée');
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
      if (isUniqueViolation(e, 'reverses')) {
        throw new ConflictException('Ce mouvement a déjà été annulé');
      }
      if (isUniqueViolation(e, 'idempotency')) {
        const raced = await this.prisma.movement.findUnique({ where: { idempotencyKey }, include: { wine: true } });
        if (raced) {
          const { wine: racedWine, ...movement } = raced;
          return { movement, wine: racedWine, stock: await this.stockOf(raced.wineId), created: false };
        }
      }
      throw e;
    }
  }

  async createOut(input: CreateOutInput): Promise<MovementResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité doit être un entier positif');
    }
    const replay = await this.findOutReplay(input);
    if (replay) return replay;

    const wine = await this.prisma.wine.findUnique({ where: { id: input.wineId } });
    if (!wine) throw new NotFoundException('Vin introuvable');

    try {
      const movement = await this.prisma.movement.create({
        data: {
          wineId: wine.id,
          delta: -input.quantity,
          type: 'OUT',
          photoId: input.photoId ?? null,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { movement, wine, stock: await this.stockOf(wine.id), created: true };
    } catch (e) {
      // Course perdue contre un double tap ou un second téléphone : la clé ou la
      // photo a été écrite entre la vérification et l'insertion.
      // Toute violation d'unicité, sans se fier au nom d'index que Prisma remonte
      // pour un index partiel écrit à la main.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.findOutReplay(input);
        if (raced) return raced;
      }
      if (e instanceof Error && /aucune bouteille/.test(e.message)) {
        throw new ConflictException(`Il n’en reste que ${await this.stockOf(wine.id)}`);
      }
      throw e;
    }
  }

  /** Une même clé, ou une même photo, ne débite qu'une fois : on renvoie la première sortie. */
  private async findOutReplay(input: CreateOutInput): Promise<MovementResult | null> {
    const byKey = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } });
    // La clé appartient déjà à un autre mouvement (une entrée, un inventaire, ou
    // la sortie d'un autre vin) : la rejouer comme une sortie mentirait au client
    // en lui disant « Sorti » sans qu'aucune bouteille n'ait bougé.
    if (byKey && (byKey.type !== 'OUT' || byKey.wineId !== input.wineId)) {
      throw new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement');
    }
    const byPhoto =
      byKey ?? (input.photoId ? await this.prisma.movement.findFirst({ where: { photoId: input.photoId, type: 'OUT' }, include: { wine: true } }) : null);
    if (!byPhoto) return null;
    const { wine, ...movement } = byPhoto;
    return { movement, wine, stock: await this.stockOf(byPhoto.wineId), created: false };
  }

  /**
   * Inventaire physique : l'utilisateur a compté N bouteilles, l'écart avec le
   * journal devient un mouvement ADJUST daté. Le verrou sur la ligne du vin
   * empêche deux inventaires simultanés de calculer leur écart sur le même stock.
   */
  async adjustTo(wineId: string, input: InventoryInput): Promise<InventoryResult> {
    const already = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (already) {
      // Même raisonnement que pour les sorties : une clé déjà posée sur un autre
      // mouvement (ou un inventaire d'un autre vin) ne doit pas être rejouée
      // comme si l'inventaire avait eu lieu.
      if (already.type !== 'ADJUST' || already.wineId !== wineId) {
        throw new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement');
      }
      return { movement: already, stock: await this.stockOf(wineId), delta: already.delta, created: false };
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM wine WHERE id = ${wineId} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Vin introuvable');
      const [{ quantity }] = await tx.$queryRaw<{ quantity: number }[]>`
        SELECT COALESCE(SUM(delta), 0)::INTEGER AS quantity FROM movement WHERE wine_id = ${wineId}`;
      const delta = input.counted - quantity;
      if (delta === 0) return { movement: null, stock: quantity, delta: 0, created: false };
      const movement = await tx.movement.create({
        data: { wineId, delta, type: 'ADJUST', note: `Inventaire : ${input.counted} comptées`, idempotencyKey: input.idempotencyKey },
      });
      return { movement, stock: input.counted, delta, created: true };
    });
  }

  recent(limit = 20): Promise<Array<Movement & { wine: Wine }>> {
    return this.prisma.movement.findMany({ take: limit, orderBy: { occurredAt: 'desc' }, include: { wine: true } });
  }
}
