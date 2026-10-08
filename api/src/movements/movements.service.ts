import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Movement, Prisma, Wine } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CANCEL_MOVED, labelOf, normalizeLocation, NOT_ENOUGH_AT_LOCATION, partsOf, Place, SAME_LOCATION } from '../locations/location';
import { Db, LocationsService } from '../locations/locations.service';
import { PairingScheduler } from '../pairing/pairing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProducerScheduler } from '../producers/producers.service';
import { WineMatchingService } from '../wines/wine-matching.service';
import { CreateMovementInput, CreateOutInput, InventoryInput, MoveInput } from './dto';

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

/** Une image du web choisie comme vignette n'est la photo d'aucune bouteille. */
const WEB_IMAGE_FOR_MOVEMENT = 'Cette image vient du web : prenez une photo de la bouteille';
const KEY_REUSED = 'Clé d’idempotence déjà utilisée pour un autre mouvement';

/**
 * La clé d'idempotence est unique sur toutes les caves : un rejeu ne rend un
 * mouvement que s'il appartient à la cave courante. Sinon la clé est « déjà
 * utilisée », sans rien dévoiler du mouvement de l'autre cave.
 */
function ownReplay<T extends { wine: Wine }>(found: T | null, caveId: string): T | null {
  if (found && found.wine.caveId !== caveId) throw new ConflictException(KEY_REUSED);
  return found;
}

/**
 * Lien entre les deux moitiés d'un déplacement : elles partagent la clé
 * d'idempotence de la demande, suffixée `:from` (−N à l'origine) et `:to` (+N à
 * la destination). Les clés des clients sont des UUID : aucun suffixe ne peut
 * entrer en collision avec elles. Annuler une moitié retrouve l'autre par ce
 * suffixe ; l'annulation de l'autre prend la clé d'annulation suffixée `:paire`.
 */
const MOVE_FROM = ':from';
const MOVE_TO = ':to';
export function movePartnerKey(key: string): string | null {
  if (key.endsWith(MOVE_FROM)) return key.slice(0, -MOVE_FROM.length) + MOVE_TO;
  if (key.endsWith(MOVE_TO)) return key.slice(0, -MOVE_TO.length) + MOVE_FROM;
  return null;
}

/** Verrou sur la ligne du vin (même verrou que l'inventaire et le déclencheur de stock) ; vin d'une autre cave : 404. */
async function lockWine(tx: Db, caveId: string, wineId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM wine WHERE id = ${wineId} AND cave_id = ${caveId} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundException('Vin introuvable');
}

export interface MoveResult { locations: Place[] }

/** Mouvement du journal avec le libellé de son emplacement (null = « Sans emplacement »). */
export type JournalMovement = Movement & { wine: Wine; locationLabel: string | null };

@Injectable()
export class MovementsService {
  private readonly logger = new Logger(MovementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: WineMatchingService,
    private readonly locations: LocationsService,
    @Optional() private readonly pairings?: PairingScheduler,
    @Optional() private readonly producers?: ProducerScheduler,
  ) {}

  /**
   * Une clé déjà prise par un déplacement (ses moitiés portent `K:from` et `K:to`)
   * ne sert pas à un autre mouvement : 409, comme toute clé réutilisée.
   */
  private async assertKeyNotUsedByMove(key: string): Promise<void> {
    if (await this.prisma.movement.findUnique({ where: { idempotencyKey: key + MOVE_FROM }, select: { id: true } })) {
      throw new ConflictException(KEY_REUSED);
    }
  }

  async stockOf(wineId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock_courant WHERE wine_id = ${wineId}`;
    return rows[0]?.quantity ?? 0;
  }

  /** Entrée dans la cave `caveId` : le vin est rapproché ou créé dans cette cave seulement. */
  async createIn(caveId: string, input: CreateMovementInput): Promise<MovementResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité doit être un entier positif');
    }
    const existing = ownReplay(
      await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } }),
      caveId,
    );
    if (existing) {
      const { wine, ...movement } = existing;
      return { movement, wine, stock: await this.stockOf(existing.wineId), created: false };
    }

    const photo = input.photoId
      ? await this.prisma.photo.findFirst({ where: { id: input.photoId, caveId }, select: { status: true, purpose: true } })
      : null;
    // Une photo d'une autre cave est traitée comme une photo inconnue.
    if (input.photoId && !photo) throw new NotFoundException('Photo introuvable');
    // Une image du web choisie comme vignette n'est pas la photo d'une bouteille entrée.
    if (photo?.purpose === 'REFERENCE') throw new BadRequestException(WEB_IMAGE_FOR_MOVEMENT);
    // Emplacement vérifié avant de créer le moindre vin (400 aux messages de la spec).
    if (input.location) normalizeLocation(input.location);
    if (input.location?.zoneId) await this.locations.assertZone(caveId, input.location.zoneId);
    await this.assertKeyNotUsedByMove(input.idempotencyKey);

    const { wine, created: wineCreated } = await this.matching.matchOrCreate(caveId, input.wine);
    // Une fiche confirmée avant la fin de l'analyse n'a montré aucune lecture :
    // la mesure « zéro saisie » la comparera à un formulaire vide.
    const readingShown = photo?.status === 'DONE';
    try {
      // Emplacement et mouvement dans une même transaction : une insertion qui
      // échoue ne laisse pas derrière elle un emplacement créé pour rien.
      const movement = await this.prisma.$transaction(async (tx) => {
        const location = input.location ? await this.locations.resolve(caveId, input.location, tx) : null;
        return tx.movement.create({
          data: {
            wineId: wine.id,
            delta: input.quantity,
            type: 'IN',
            photoId: input.photoId ?? null,
            priceUnitCents: input.priceUnitCents ?? null,
            note: input.note ?? null,
            idempotencyKey: input.idempotencyKey,
            locationId: location?.id ?? null,
            // La fiche telle que confirmée, comparée plus tard à la lecture de la
            // photo pour mesurer la part de saisie manuelle (mesure « zéro saisie »).
            ...(input.photoId ? { confirmedWine: { ...input.wine, readingShown } } : {}),
          },
        });
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

      // Nouveau vin : ses accords sont suggérés en tâche de fond. Une file
      // indisponible ne doit jamais faire échouer ni retenir l'entrée : on
      // n'attend pas la mise en file (Redis injoignable, la connexion BullMQ met
      // les commandes en attente sans fin), le rattrapage du worker reprendra ce
      // vin au prochain démarrage.
      if (wineCreated && this.pairings) {
        void this.pairings.schedule(wine.id).catch((e: unknown) =>
          this.logger.warn(`Accords de ${wine.id} non mis en file : ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      // Même règle pour le descriptif de son domaine, demandé seulement s'il n'existe pas encore.
      if (wineCreated && this.producers) {
        void this.producers.scheduleIfMissing(wine.producer).catch((e: unknown) =>
          this.logger.warn(`Descriptif du domaine « ${wine.producer} » non mis en file : ${e instanceof Error ? e.message : String(e)}`),
        );
      }

      return { movement, wine, stock: await this.stockOf(wine.id), created: true };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency')) {
        const raced = ownReplay(
          await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } }),
          caveId,
        );
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

  /** Annule un mouvement de la cave ; un mouvement d'une autre cave est « introuvable ». */
  async cancel(caveId: string, movementId: string, idempotencyKey: string): Promise<MovementResult> {
    const already = ownReplay(await this.prisma.movement.findUnique({ where: { idempotencyKey }, include: { wine: true } }), caveId);
    if (already) {
      const { wine, ...movement } = already;
      return { movement, wine, stock: await this.stockOf(already.wineId), created: false };
    }

    const original = await this.prisma.movement.findFirst({ where: { id: movementId, wine: { caveId } }, include: { wine: true } });
    if (!original) throw new NotFoundException('Mouvement introuvable');
    if (original.reversesId) throw new ConflictException('Une annulation ne peut pas être annulée');
    // Un déplacement s'annule par paire : l'autre moitié est retrouvée par sa clé (voir movePartnerKey).
    const partnerKey = original.type === 'MOVE' ? movePartnerKey(original.idempotencyKey) : null;
    const partner = partnerKey ? await this.prisma.movement.findFirst({ where: { idempotencyKey: partnerKey, wineId: original.wineId, type: 'MOVE' } }) : null;
    const halves = partner ? [original, partner] : [original];
    const reversal = await this.prisma.movement.findFirst({ where: { reversesId: { in: halves.map((h) => h.id) } } });
    if (reversal) throw new ConflictException('Ce mouvement a déjà été annulé');

    try {
      const movement = await this.prisma.$transaction(async (tx) => {
        await lockWine(tx, caveId, original.wineId);
        // Les bouteilles qui reviennent à un emplacement : sa zone ne doit pas être archivée.
        for (const half of halves) if (half.delta < 0) await this.locations.reopenZoneOf(caveId, half.locationId, tx);
        const reversals = [];
        // La moitié qui rend des bouteilles d'abord (annulation du −N) : le total du vin ne passe
        // jamais sous zéro en cours de route, et un manque est signalé par emplacement (409) plutôt
        // que par le déclencheur du total.
        for (const half of [...halves].sort((a, b) => a.delta - b.delta)) {
          reversals.push(
            await tx.movement.create({
              data: {
                wineId: original.wineId,
                delta: -half.delta,
                type: 'ADJUST',
                note: `Annulation du mouvement ${half.id}`,
                idempotencyKey: half.id === original.id ? idempotencyKey : `${idempotencyKey}:paire`,
                reversesId: half.id,
                // La bouteille revient (ou repart) à l'emplacement du mouvement annulé.
                locationId: half.locationId,
              },
            }),
          );
        }
        const emptied = halves.filter((h) => h.delta > 0).map((h) => h.locationId);
        await this.locations.assertEnoughAt(caveId, original.wineId, emptied, tx);
        return reversals.find((r) => r.reversesId === original.id)!;
      });
      return { movement, wine: original.wine, stock: await this.stockOf(original.wineId), created: true };
    } catch (e) {
      if (e instanceof Error && /aucune bouteille/.test(e.message)) {
        throw new ConflictException('Impossible d’annuler : il ne reste aucune bouteille de ce vin');
      }
      // L'emplacement d'origine n'a plus ces bouteilles : elles en sont reparties depuis.
      if (e instanceof ConflictException && e.message === NOT_ENOUGH_AT_LOCATION) {
        throw new ConflictException(CANCEL_MOVED);
      }
      if (isUniqueViolation(e, 'reverses')) {
        throw new ConflictException('Ce mouvement a déjà été annulé');
      }
      if (isUniqueViolation(e, 'idempotency')) {
        const raced = ownReplay(await this.prisma.movement.findUnique({ where: { idempotencyKey }, include: { wine: true } }), caveId);
        if (raced) {
          const { wine: racedWine, ...movement } = raced;
          return { movement, wine: racedWine, stock: await this.stockOf(raced.wineId), created: false };
        }
      }
      throw e;
    }
  }

  /** Sortie d'un vin de la cave ; un vin ou une photo d'une autre cave est « introuvable ». */
  async createOut(caveId: string, input: CreateOutInput): Promise<MovementResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité doit être un entier positif');
    }
    // Le vin d'abord : un rejeu ne rend que les sorties de ce vin, donc de cette cave.
    const wine = await this.prisma.wine.findFirst({ where: { id: input.wineId, caveId } });
    if (!wine) throw new NotFoundException('Vin introuvable');

    const plan = await this.planOut(caveId, input);
    if ('replay' in plan) return plan.replay;
    if (input.locationId) await this.locations.findOwn(caveId, input.locationId);

    try {
      // Sous le verrou du vin : l'endroit choisi est relu et contrôlé après écriture.
      const movement = await this.prisma.$transaction(async (tx) => {
        await lockWine(tx, caveId, wine.id);
        const locationId = input.locationId !== undefined ? input.locationId : await this.legacyExitPlace(caveId, wine.id, input.quantity, tx);
        const created = await tx.movement.create({
          data: {
            wineId: wine.id,
            delta: -input.quantity,
            type: 'OUT',
            photoId: plan.photoId,
            idempotencyKey: input.idempotencyKey,
            locationId,
          },
        });
        await this.locations.assertEnoughAt(caveId, wine.id, [locationId], tx);
        return created;
      });
      return { movement, wine, stock: await this.stockOf(wine.id), created: true };
    } catch (e) {
      // Course perdue contre un double tap ou un second téléphone : la clé ou la
      // photo a été écrite entre la vérification et l'insertion.
      // Toute violation d'unicité, sans se fier au nom d'index que Prisma remonte
      // pour un index partiel écrit à la main : on réévalue avec les mêmes règles
      // (rejeu, 409 pour un autre vin) maintenant que la ligne gagnante est visible.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.planOut(caveId, input);
        if ('replay' in raced) return raced.replay;
      }
      if (e instanceof Error && /aucune bouteille/.test(e.message)) {
        throw new ConflictException(`Il n’en reste que ${await this.stockOf(wine.id)}`);
      }
      throw e;
    }
  }

  /**
   * Décide quoi faire d'une demande de sortie avant d'écrire :
   * - la clé a déjà servi à cette sortie → on la rejoue (double tap, file hors ligne) ;
   * - la photo a déjà sorti ce même vin, sortie non annulée → on la rejoue ;
   * - la photo a déjà sorti un AUTRE vin, sortie non annulée → 409 : répondre
   *   « Sorti » mentirait, aucune bouteille de ce vin-ci n'aurait bougé ;
   * - la sortie de cette photo a été annulée → nouvelle sortie, écrite sans photo
   *   car idx_movement_photo_out n'admet qu'une sortie par photo (la clé
   *   d'idempotence protège toujours contre le double tap).
   */
  private async planOut(caveId: string, input: CreateOutInput): Promise<{ replay: MovementResult } | { photoId: string | null }> {
    const byKey = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { wine: true } });
    if (byKey) {
      // La clé appartient déjà à un autre mouvement (une entrée, un inventaire, ou
      // la sortie d'un autre vin) : la rejouer comme une sortie mentirait au client
      // en lui disant « Sorti » sans qu'aucune bouteille n'ait bougé.
      if (byKey.type !== 'OUT' || byKey.wineId !== input.wineId) {
        throw new ConflictException(KEY_REUSED);
      }
      return { replay: await this.asReplay(byKey) };
    }
    await this.assertKeyNotUsedByMove(input.idempotencyKey);
    if (!input.photoId) return { photoId: null };
    const photo = await this.prisma.photo.findFirst({ where: { id: input.photoId, caveId }, select: { purpose: true } });
    // Une photo d'une autre cave est traitée comme une photo inconnue.
    if (!photo) throw new NotFoundException('Photo introuvable');
    // Une image du web choisie comme vignette n'est pas la photo d'une bouteille sortie.
    if (photo?.purpose === 'REFERENCE') throw new BadRequestException(WEB_IMAGE_FOR_MOVEMENT);

    const byPhoto = await this.prisma.movement.findFirst({ where: { photoId: input.photoId, type: 'OUT' }, include: { wine: true } });
    if (!byPhoto) return { photoId: input.photoId };
    const reversal = await this.prisma.movement.findFirst({ where: { reversesId: byPhoto.id } });
    if (reversal) return { photoId: null };
    if (byPhoto.wineId !== input.wineId) {
      throw new ConflictException('Cette photo a déjà servi à sortir un autre vin — annulez d’abord cette sortie');
    }
    return { replay: await this.asReplay(byPhoto) };
  }

  /**
   * Endroit d'une sortie ou d'une baisse d'inventaire envoyée sans `locationId`
   * (ancien client) : « Sans emplacement » s'il en a assez, sinon la
   * pré-sélection (exitDefault) si elle en a assez, sinon le premier endroit
   * qui en a assez. Aucun endroit n'en a assez : « Sans emplacement », et le
   * contrôle après écriture répond 409 (ou le déclencheur, si le total manque).
   */
  private async legacyExitPlace(caveId: string, wineId: string, quantity: number, tx: Db): Promise<string | null> {
    const places = await this.locations.stockByLocation(caveId, wineId, tx);
    const enough = (id: string | null | undefined) => places.some((p) => p.id === id && p.quantity >= quantity);
    if (enough(null)) return null;
    const preferred = await this.locations.exitDefault(caveId, wineId, tx);
    if (preferred !== undefined && enough(preferred)) return preferred;
    return places.find((p) => p.quantity >= quantity)?.id ?? null;
  }

  private async asReplay(found: Movement & { wine: Wine }): Promise<MovementResult> {
    const { wine, ...movement } = found;
    return { movement, wine, stock: await this.stockOf(found.wineId), created: false };
  }

  /**
   * Inventaire physique : l'utilisateur a compté N bouteilles, l'écart avec le
   * journal devient un mouvement ADJUST daté. Le verrou sur la ligne du vin
   * empêche deux inventaires simultanés de calculer leur écart sur le même stock.
   */
  async adjustTo(caveId: string, wineId: string, input: InventoryInput): Promise<InventoryResult> {
    // Un vin d'une autre cave est « introuvable », avant tout rejeu qui dévoilerait son stock.
    if (!(await this.prisma.wine.findFirst({ where: { id: wineId, caveId }, select: { id: true } }))) {
      throw new NotFoundException('Vin introuvable');
    }
    const already = await this.prisma.movement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (already) {
      // Même raisonnement que pour les sorties : une clé déjà posée sur un autre
      // mouvement (ou un inventaire d'un autre vin) ne doit pas être rejouée
      // comme si l'inventaire avait eu lieu.
      if (already.type !== 'ADJUST' || already.wineId !== wineId) {
        throw new ConflictException(KEY_REUSED);
      }
      return { movement: already, stock: await this.stockOf(wineId), delta: already.delta, created: false };
    }

    await this.assertKeyNotUsedByMove(input.idempotencyKey);
    if (input.locationId) await this.locations.findOwn(caveId, input.locationId);
    if (input.location) normalizeLocation(input.location);

    return this.prisma.$transaction(async (tx) => {
      await lockWine(tx, caveId, wineId);
      const [{ quantity }] = await tx.$queryRaw<{ quantity: number }[]>`
        SELECT COALESCE(SUM(delta), 0)::INTEGER AS quantity FROM movement WHERE wine_id = ${wineId}`;
      const delta = input.counted - quantity;
      if (delta === 0) return { movement: null, stock: quantity, delta: 0, created: false };
      // Une hausse va à l'endroit choisi ou saisi (par défaut « Sans emplacement ») ; une baisse s'y applique.
      const locationId =
        input.location ? (await this.locations.resolve(caveId, input.location, tx)).id
          : input.locationId !== undefined ? input.locationId : delta > 0 ? null : await this.legacyExitPlace(caveId, wineId, -delta, tx);
      // Une hausse vers un emplacement existant : sa zone ne doit pas être archivée.
      if (delta > 0 && !input.location) await this.locations.reopenZoneOf(caveId, locationId, tx);
      const movement = await tx.movement.create({
        data: { wineId, delta, type: 'ADJUST', note: `Inventaire : ${input.counted} comptées`, idempotencyKey: input.idempotencyKey, locationId },
      });
      if (delta < 0) await this.locations.assertEnoughAt(caveId, wineId, [locationId], tx);
      return { movement, stock: input.counted, delta, created: true };
    });
  }

  /**
   * Range ou déplace `quantity` bouteilles d'un endroit (null = « Sans
   * emplacement ») vers un emplacement saisi, créé à la volée. Deux mouvements
   * MOVE de même date (+N à la destination, −N à l'origine), liés par leur clé
   * (voir movePartnerKey) : le stock total ne change pas.
   */
  async move(caveId: string, wineId: string, input: MoveInput): Promise<MoveResult> {
    if (!(await this.prisma.wine.findFirst({ where: { id: wineId, caveId }, select: { id: true } }))) {
      throw new NotFoundException('Vin introuvable');
    }
    const key = input.idempotencyKey ?? randomUUID();
    const replay = async () => {
      const done = await this.prisma.movement.findUnique({ where: { idempotencyKey: key + MOVE_FROM }, include: { wine: true } });
      if (!done) return null;
      if (done.wine.caveId !== caveId || done.wineId !== wineId || done.type !== 'MOVE') throw new ConflictException(KEY_REUSED);
      return { locations: await this.locations.stockByLocation(caveId, wineId) };
    };
    const already = await replay();
    if (already) return already;
    // La clé de la demande elle-même déjà prise par une entrée, une sortie ou un inventaire.
    if (await this.prisma.movement.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) throw new ConflictException(KEY_REUSED);
    if (input.from) await this.locations.findOwn(caveId, input.from);
    normalizeLocation(input.to);

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockWine(tx, caveId, wineId);
        const to = await this.locations.resolve(caveId, input.to, tx);
        if (to.id === input.from) throw new BadRequestException(SAME_LOCATION);
        const occurredAt = new Date();
        // L'arrivée d'abord : le total du vin ne baisse jamais en cours de route.
        await tx.movement.create({ data: { wineId, delta: input.quantity, type: 'MOVE', occurredAt, idempotencyKey: key + MOVE_TO, locationId: to.id } });
        await tx.movement.create({ data: { wineId, delta: -input.quantity, type: 'MOVE', occurredAt, idempotencyKey: key + MOVE_FROM, locationId: input.from } });
        await this.locations.assertEnoughAt(caveId, wineId, [input.from], tx);
      });
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency')) {
        const raced = await replay();
        if (raced) return raced;
      }
      throw e;
    }
    return { locations: await this.locations.stockByLocation(caveId, wineId) };
  }

  /** Journal de la cave : ses derniers mouvements, tous vins confondus. */
  async recent(caveId: string, limit = 20): Promise<JournalMovement[]> {
    const rows = await this.prisma.movement.findMany({
      where: { wine: { caveId } }, take: limit, orderBy: { occurredAt: 'desc' }, include: { wine: true, location: { include: { zone: true } } },
    });
    return rows.map(({ location, ...m }) => ({ ...m, locationLabel: location ? labelOf(partsOf(location)) : null }));
  }
}
