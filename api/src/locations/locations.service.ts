import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Location, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ZONE_NOT_FOUND } from '../zones/zone';
import {
  LocatedParts, LOCATION_NOT_FOUND, LocationInput, labelOf, normalizeLocation, NOT_ENOUGH_AT_LOCATION, Place, placesOf,
} from './location';

/** Client Prisma ordinaire ou client d'une transaction interactive. */
export type Db = PrismaService | Prisma.TransactionClient;

/** `lastUsed` : emplacement de la dernière entrée rangée de la cave (pré-remplit l'entrée suivante), un seul au plus. */
export interface LocationView extends LocatedParts { label: string; lastUsed: boolean }

/** Somme des mouvements d'un vin à un endroit ; `zone` : nom de la zone (relation), `zoneId` : son id. */
interface Group { locationId: string | null; zoneId: string | null; zone: string | null; casier: string | null; position: string | null; quantity: number }

/** Colonnes d'un emplacement et de sa zone, pour les requêtes qui joignent `location l` et `cave_zone z`. */
const PARTS = Prisma.sql`l.zone_id AS "zoneId", z.name AS zone, l.casier, l.position`;

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

  /**
   * Emplacements de la cave, par libellé (nom actuel de la zone) ; `lastUsed`
   * sur celui de la dernière entrée rangée. Ceux d'une zone archivée (vides,
   * l'historique seul les désigne) n'y figurent pas.
   */
  async list(caveId: string): Promise<LocationView[]> {
    const [rows, last] = await Promise.all([
      this.prisma.$queryRaw<LocatedParts[]>`
        SELECT l.id, ${PARTS}
        FROM location l LEFT JOIN cave_zone z ON z.id = l.zone_id
        WHERE l.cave_id = ${caveId} AND z.archived_at IS NULL`,
      this.lastIn(caveId),
    ]);
    return rows
      .map((l) => ({ ...l, label: labelOf(l), lastUsed: l.id === last?.id }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }

  /**
   * Emplacement saisi, créé à la volée. La zone est une zone non archivée de la
   * cave (sinon 404 « Zone introuvable »), lue FOR SHARE : une suppression de
   * zone simultanée attend la fin de l'écriture, et voit alors ses bouteilles.
   * INSERT … ON CONFLICT sur l'index location_place_key (cave, zone, casier et
   * position en minuscules) : deux saisies simultanées du même emplacement
   * obtiennent la même ligne, sans violation d'unicité (P2002) à rattraper —
   * utilisable aussi dans une transaction, qu'une violation interromprait.
   */
  async resolve(caveId: string, input: LocationInput, db: Db = this.prisma): Promise<Location> {
    const n = normalizeLocation(input);
    const zoneId = n.zoneId ? await this.lockZone(caveId, n.zoneId, db) : n.zoneName ? await this.zoneNamed(caveId, n.zoneName, db) : null;
    const [row] = await db.$queryRaw<Location[]>`
      INSERT INTO location (id, cave_id, zone_id, casier, position)
      VALUES (${randomUUID()}, ${caveId}, ${zoneId}, ${n.casier}, ${n.position})
      ON CONFLICT (cave_id, (COALESCE(zone_id, '')), (lower(COALESCE(casier, ''))), (lower(COALESCE(position, ''))))
      DO UPDATE SET cave_id = EXCLUDED.cave_id
      RETURNING id, cave_id AS "caveId", zone_id AS "zoneId", casier, position, created_at AS "createdAt"`;
    return row;
  }

  /** Zone non archivée de la cave, sinon 404 « Zone introuvable » : vérifiée avant de créer le moindre vin. */
  async assertZone(caveId: string, zoneId: string): Promise<void> {
    if (!(await this.prisma.caveZone.findFirst({ where: { id: zoneId, caveId, archivedAt: null }, select: { id: true } }))) {
      throw new NotFoundException(ZONE_NOT_FOUND);
    }
  }

  /** Zone non archivée de la cave, verrouillée en partage jusqu'à la fin de la transaction ; sinon 404. */
  private async lockZone(caveId: string, zoneId: string, db: Db): Promise<string> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM cave_zone WHERE id = ${zoneId} AND cave_id = ${caveId} AND archived_at IS NULL FOR SHARE`;
    if (rows.length === 0) throw new NotFoundException(ZONE_NOT_FOUND);
    return rows[0].id;
  }

  /**
   * Ancien client (`zone` en texte) : la zone non archivée de même nom (espaces
   * autour et casse ignorés), créée en fin de liste si la cave n'en a pas. ON
   * CONFLICT sur l'index cave_zone_cave_id_name_key : deux saisies simultanées
   * du même nom obtiennent la même zone.
   */
  private async zoneNamed(caveId: string, name: string, db: Db): Promise<string> {
    const [row] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO cave_zone (id, cave_id, name, sort_order)
      VALUES (${randomUUID()}, ${caveId}, ${name},
              (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM cave_zone WHERE cave_id = ${caveId} AND archived_at IS NULL))
      ON CONFLICT (cave_id, (lower(name))) WHERE archived_at IS NULL
      DO UPDATE SET name = cave_zone.name
      RETURNING id`;
    return row.id;
  }

  /** Emplacement de la cave ; celui d'une autre cave est « introuvable », comme un identifiant inconnu. */
  async findOwn(caveId: string, id: string, db: Db = this.prisma): Promise<Location> {
    const loc = await db.location.findFirst({ where: { id, caveId } });
    if (!loc) throw new NotFoundException(LOCATION_NOT_FOUND);
    return loc;
  }

  private groups(caveId: string, wineId: string, db: Db): Promise<Group[]> {
    return db.$queryRaw<Group[]>`
      SELECT m.location_id AS "locationId", ${PARTS}, SUM(m.delta)::INTEGER AS quantity
      FROM movement m
      JOIN wine w ON w.id = m.wine_id
      LEFT JOIN location l ON l.id = m.location_id
      LEFT JOIN cave_zone z ON z.id = l.zone_id
      WHERE m.wine_id = ${wineId} AND w.cave_id = ${caveId}
      GROUP BY m.location_id, l.zone_id, z.name, l.casier, l.position`;
  }

  /** Endroits du vin et leur quantité (> 0) : emplacements par libellé, « Sans emplacement » en dernier. */
  async stockByLocation(caveId: string, wineId: string, db: Db = this.prisma): Promise<Place[]> {
    return placesOf((await this.groups(caveId, wineId, db)).map(toPlaceGroup));
  }

  /** Endroits de plusieurs vins de la cave en une requête (même règle que stockByLocation). */
  async placesByWine(caveId: string, wineIds: string[]): Promise<Map<string, Place[]>> {
    if (wineIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<Group & { wineId: string }>>`
      SELECT m.wine_id AS "wineId", m.location_id AS "locationId", ${PARTS}, SUM(m.delta)::INTEGER AS quantity
      FROM movement m
      JOIN wine w ON w.id = m.wine_id
      LEFT JOIN location l ON l.id = m.location_id
      LEFT JOIN cave_zone z ON z.id = l.zone_id
      WHERE w.cave_id = ${caveId} AND m.wine_id IN (${Prisma.join(wineIds)})
      GROUP BY m.wine_id, m.location_id, l.zone_id, z.name, l.casier, l.position`;
    const byWine = new Map<string, Group[]>();
    for (const r of rows) byWine.set(r.wineId, [...(byWine.get(r.wineId) ?? []), r]);
    return new Map([...byWine].map(([id, groups]) => [id, placesOf(groups.map(toPlaceGroup))]));
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

  /** Dernière entrée rangée et non annulée de la cave, hors zone archivée : son emplacement. */
  private async lastIn(caveId: string): Promise<{ id: string } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT l.id
      FROM movement m
      JOIN wine w ON w.id = m.wine_id
      JOIN location l ON l.id = m.location_id
      LEFT JOIN cave_zone z ON z.id = l.zone_id
      WHERE w.cave_id = ${caveId} AND m.type = 'IN' AND z.archived_at IS NULL
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
   * `known` : endroits déjà lus par l'appelant (fiche), pour ne pas les relire.
   */
  async exitDefault(caveId: string, wineId: string, db: Db = this.prisma, known?: Place[]): Promise<string | null | undefined> {
    const [places, received] = await Promise.all([
      known ?? this.stockByLocation(caveId, wineId, db),
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
    location: g.locationId == null ? null : { id: g.locationId, zoneId: g.zoneId, zone: g.zone, casier: g.casier, position: g.position },
    quantity: Number(g.quantity),
  };
}
