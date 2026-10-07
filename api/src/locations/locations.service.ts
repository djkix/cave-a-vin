import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Location, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  LOCATION_NOT_FOUND, LocationInput, LocationParts, labelOf, normalizeLocation, NOT_ENOUGH_AT_LOCATION, Place, placesOf,
} from './location';

/** Client Prisma ordinaire ou client d'une transaction interactive. */
export type Db = PrismaService | Prisma.TransactionClient;

export interface LocationView extends LocationParts { id: string; label: string }

interface Group extends LocationParts { locationId: string | null; quantity: number }

/** Stock d'un endroit (id null = « Sans emplacement ») selon la même règle que placesOf, négatif compris. */
function rawStockAt(groups: Group[], id: string | null): number {
  if (id != null) return groups.find((g) => g.locationId === id)?.quantity ?? 0;
  const total = groups.reduce((s, g) => s + g.quantity, 0);
  return total - groups.filter((g) => g.locationId != null && g.quantity > 0).reduce((s, g) => s + g.quantity, 0);
}

/**
 * Emplacements d'une cave. Aucune quantité n'est stockée : le stock d'un
 * emplacement est la somme des mouvements du vin à cet emplacement.
 */
@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Emplacements de la cave, par libellé. */
  async list(caveId: string): Promise<LocationView[]> {
    const rows = await this.prisma.location.findMany({ where: { caveId }, select: { id: true, zone: true, casier: true, position: true } });
    return rows.map((l) => ({ ...l, label: labelOf(l) })).sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }

  /**
   * Emplacement saisi, créé à la volée. INSERT … ON CONFLICT sur (cave_id,
   * label_key) : deux saisies simultanées du même emplacement obtiennent la même
   * ligne, sans violation d'unicité (P2002) à rattraper — utilisable aussi dans
   * une transaction, qu'une violation interromprait.
   */
  async resolve(caveId: string, input: LocationInput, db: Db = this.prisma): Promise<Location> {
    const n = normalizeLocation(input);
    const [row] = await db.$queryRaw<Location[]>`
      INSERT INTO location (id, cave_id, zone, casier, position, label_key)
      VALUES (${randomUUID()}, ${caveId}, ${n.zone}, ${n.casier}, ${n.position}, ${n.labelKey})
      ON CONFLICT (cave_id, label_key) DO UPDATE SET label_key = EXCLUDED.label_key
      RETURNING id, cave_id AS "caveId", zone, casier, position, label_key AS "labelKey", created_at AS "createdAt"`;
    return row;
  }

  /** Emplacement de la cave ; celui d'une autre cave est « introuvable », comme un identifiant inconnu. */
  async findOwn(caveId: string, id: string, db: Db = this.prisma): Promise<Location> {
    const loc = await db.location.findFirst({ where: { id, caveId } });
    if (!loc) throw new NotFoundException(LOCATION_NOT_FOUND);
    return loc;
  }

  private groups(caveId: string, wineId: string, db: Db): Promise<Group[]> {
    return db.$queryRaw<Group[]>`
      SELECT m.location_id AS "locationId", l.zone, l.casier, l.position, SUM(m.delta)::INTEGER AS quantity
      FROM movement m
      JOIN wine w ON w.id = m.wine_id
      LEFT JOIN location l ON l.id = m.location_id
      WHERE m.wine_id = ${wineId} AND w.cave_id = ${caveId}
      GROUP BY m.location_id, l.zone, l.casier, l.position`;
  }

  /** Endroits du vin et leur quantité (> 0) : emplacements par libellé, « Sans emplacement » en dernier. */
  async stockByLocation(caveId: string, wineId: string, db: Db = this.prisma): Promise<Place[]> {
    return placesOf((await this.groups(caveId, wineId, db)).map(toPlaceGroup));
  }

  /**
   * Après écriture, dans la transaction qui tient le verrou du vin : aucun des
   * endroits touchés ne doit être passé sous zéro. Sinon 409 et la transaction
   * est annulée. (Le déclencheur de la base ne contrôle que le total du vin.)
   */
  async assertEnoughAt(caveId: string, wineId: string, places: Array<string | null>, db: Db): Promise<void> {
    const groups = await this.groups(caveId, wineId, db);
    if (places.some((p) => rawStockAt(groups, p) < 0)) throw new ConflictException(NOT_ENOUGH_AT_LOCATION);
  }

  /** Stock actuel d'un endroit du vin (id null = « Sans emplacement »). */
  async stockAt(caveId: string, wineId: string, place: string | null, db: Db = this.prisma): Promise<number> {
    return rawStockAt(await this.groups(caveId, wineId, db), place);
  }

  /** Emplacement de la dernière entrée (non annulée) de la cave qui en a un ; pré-remplit l'entrée suivante. */
  async lastInLocation(caveId: string): Promise<LocationParts | null> {
    const rows = await this.prisma.$queryRaw<LocationParts[]>`
      SELECT l.zone, l.casier, l.position
      FROM movement m
      JOIN wine w ON w.id = m.wine_id
      JOIN location l ON l.id = m.location_id
      WHERE w.cave_id = ${caveId} AND m.type = 'IN'
        AND NOT EXISTS (SELECT 1 FROM movement r WHERE r.reverses_id = m.id)
      ORDER BY m.occurred_at DESC
      LIMIT 1`;
    return rows[0] ?? null;
  }

  /**
   * Pré-sélection de la sortie : l'endroit qui a reçu le plus récemment une
   * bouteille de ce vin (entrée ou arrivée d'un déplacement, non annulées) et
   * en a encore. id = emplacement, null = « Sans emplacement », undefined = le
   * vin n'a plus de stock. Si aucun endroit récent n'a de stock (stock venu d'un
   * inventaire), « Sans emplacement » s'il en a, sinon le premier emplacement.
   */
  async exitDefault(caveId: string, wineId: string, db: Db = this.prisma): Promise<string | null | undefined> {
    const [places, received] = await Promise.all([
      this.stockByLocation(caveId, wineId, db),
      db.$queryRaw<{ locationId: string | null }[]>`
        SELECT m.location_id AS "locationId"
        FROM movement m
        JOIN wine w ON w.id = m.wine_id
        WHERE m.wine_id = ${wineId} AND w.cave_id = ${caveId}
          AND (m.type = 'IN' OR (m.type = 'MOVE' AND m.delta > 0))
          AND NOT EXISTS (SELECT 1 FROM movement r WHERE r.reverses_id = m.id)
        ORDER BY m.occurred_at DESC`,
    ]);
    if (places.length === 0) return undefined;
    const inStock = new Set(places.map((p) => p.id));
    const recent = received.find((r) => inStock.has(r.locationId));
    if (recent) return recent.locationId;
    return inStock.has(null) ? null : places[0].id;
  }

  /**
   * Vins de la cave ayant du stock à cet endroit (filtre « Emplacement » de la
   * cave), en une requête : stocks par (vin, emplacement) puis, pour « none »,
   * total − stocks positifs par emplacement.
   */
  async wineIdsAt(caveId: string, place: string | 'none'): Promise<Set<string>> {
    const rows =
      place === 'none'
        ? await this.prisma.$queryRaw<{ wineId: string }[]>`
            SELECT g.wine_id AS "wineId"
            FROM (
              SELECT m.wine_id, m.location_id, SUM(m.delta) AS s
              FROM movement m JOIN wine w ON w.id = m.wine_id
              WHERE w.cave_id = ${caveId}
              GROUP BY m.wine_id, m.location_id
            ) g
            GROUP BY g.wine_id
            HAVING SUM(g.s) - SUM(CASE WHEN g.location_id IS NOT NULL AND g.s > 0 THEN g.s ELSE 0 END) > 0`
        : await this.prisma.$queryRaw<{ wineId: string }[]>`
            SELECT m.wine_id AS "wineId"
            FROM movement m JOIN wine w ON w.id = m.wine_id
            WHERE w.cave_id = ${caveId} AND m.location_id = ${place}
            GROUP BY m.wine_id
            HAVING SUM(m.delta) > 0`;
    return new Set(rows.map((r) => r.wineId));
  }
}

function toPlaceGroup(g: Group) {
  return {
    location: g.locationId == null ? null : { id: g.locationId, zone: g.zone, casier: g.casier, position: g.position },
    quantity: Number(g.quantity),
  };
}
