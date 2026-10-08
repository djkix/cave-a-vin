import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CaveZone, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CaveContextService } from '../caves/cave-context.service';
import { ImageNormalizationService } from '../photos/image-normalization.service';
import { PHOTO_STORAGE_DIR } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateZoneInput, UpdateZoneInput, ZONE_NAME_TAKEN, ZONE_NOT_FOUND, ZONE_PHOTO_NOT_FOUND, ZONE_STOCKED, zonePhotoPath, ZoneView, zoneView,
} from './zone';

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

async function unlinkIgnoringMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Ordre d'affichage : sort_order, puis la plus ancienne (deux zones au même rang, après une reprise). */
const ORDER: Prisma.CaveZoneOrderByWithRelationInput[] = [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

/**
 * Zones de la cave (« Ma cave ») : nom, indication, photo, ordre. Une zone
 * d'une autre cave, ou archivée, est « introuvable ».
 */
@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalization: ImageNormalizationService,
    private readonly caves: CaveContextService,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
  ) {}

  /** Zones non archivées, dans l'ordre d'affichage. */
  async list(caveId: string): Promise<ZoneView[]> {
    const zones = await this.prisma.caveZone.findMany({ where: { caveId, archivedAt: null }, orderBy: ORDER });
    return zones.map(zoneView);
  }

  private async findOwn(caveId: string, id: string): Promise<CaveZone> {
    const zone = await this.prisma.caveZone.findFirst({ where: { id, caveId, archivedAt: null } });
    if (!zone) throw new NotFoundException(ZONE_NOT_FOUND);
    return zone;
  }

  /** Nouvelle zone, en fin de liste. 409 si une zone de la cave porte déjà ce nom (casse ignorée). */
  async create(caveId: string, input: CreateZoneInput): Promise<ZoneView> {
    try {
      const zone = await this.prisma.$transaction(async (tx) => {
        const last = await tx.caveZone.aggregate({ where: { caveId, archivedAt: null }, _max: { sortOrder: true } });
        return tx.caveZone.create({ data: { caveId, name: input.name, indication: input.indication ?? null, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
      });
      return zoneView(zone);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(ZONE_NAME_TAKEN);
      throw e;
    }
  }

  /** Renommer ou changer l'indication : le nouveau nom vaut partout, l'emplacement ne change pas. */
  async update(caveId: string, id: string, input: UpdateZoneInput): Promise<ZoneView> {
    await this.findOwn(caveId, id);
    try {
      // updateMany : la condition de cave et « non archivée » est vérifiée au moment de l'écriture.
      const { count } = await this.prisma.caveZone.updateMany({
        where: { id, caveId, archivedAt: null },
        data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.indication !== undefined ? { indication: input.indication } : {}) },
      });
      if (count === 0) throw new NotFoundException(ZONE_NOT_FOUND);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(ZONE_NAME_TAKEN);
      throw e;
    }
    return zoneView(await this.findOwn(caveId, id));
  }

  /**
   * Nouvel ordre : les zones données, dans cet ordre, puis celles qui manquent
   * (créées entre-temps sur un autre téléphone) dans leur ordre actuel. Une
   * seule transaction, sous verrou des zones de la cave : deux réordonnancements
   * simultanés ne s'entremêlent pas, le dernier l'emporte en entier.
   */
  async reorder(caveId: string, ids: string[]): Promise<ZoneView[]> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM cave_zone WHERE cave_id = ${caveId} AND archived_at IS NULL
        ORDER BY sort_order, created_at, id FOR UPDATE`;
      const known = new Set(current.map((z) => z.id));
      if (ids.some((id) => !known.has(id))) throw new NotFoundException(ZONE_NOT_FOUND);
      const order = [...ids, ...current.map((z) => z.id).filter((id) => !ids.includes(id))];
      for (const [sortOrder, id] of order.entries()) await tx.caveZone.update({ where: { id }, data: { sortOrder } });
    });
    return this.list(caveId);
  }

  /**
   * Supprimer : refusé (409) tant qu'un emplacement de la zone a des
   * bouteilles ; archivée si un mouvement l'a désignée (l'historique garde son
   * libellé) ; sinon supprimée, avec ses emplacements jamais utilisés et sa
   * photo. Sous verrou de la zone : une entrée simultanée dans cette zone
   * (LocationsService.resolve la lit FOR SHARE) passe avant ou après, jamais entre.
   * `archived` dit ce qui s'est passé.
   */
  async remove(caveId: string, id: string): Promise<{ archived: boolean }> {
    const deleted = await this.prisma.$transaction(async (tx) => {
      const zone = await this.lockOwn(tx, caveId, id);
      const [{ stocked, used }] = await tx.$queryRaw<{ stocked: boolean; used: boolean }[]>`
        SELECT
          EXISTS (
            SELECT 1 FROM movement m JOIN location l ON l.id = m.location_id
            WHERE l.zone_id = ${id}
            GROUP BY m.wine_id, m.location_id
            HAVING SUM(m.delta) > 0
          ) AS stocked,
          EXISTS (SELECT 1 FROM movement m JOIN location l ON l.id = m.location_id WHERE l.zone_id = ${id}) AS used`;
      if (stocked) throw new ConflictException(ZONE_STOCKED);
      if (used) {
        await tx.caveZone.update({ where: { id }, data: { archivedAt: new Date() } });
        return { archived: true, photoPath: null };
      }
      await tx.location.deleteMany({ where: { zoneId: id } });
      await tx.caveZone.delete({ where: { id } });
      return { archived: false, photoPath: zone.photoPath };
    });
    if (deleted.photoPath) await unlinkIgnoringMissing(join(this.dir, deleted.photoPath));
    return { archived: deleted.archived };
  }

  /** Zone non archivée de la cave, verrouillée (FOR UPDATE) jusqu'à la fin de la transaction ; sinon 404. */
  private async lockOwn(tx: Prisma.TransactionClient, caveId: string, id: string): Promise<{ photoPath: string | null }> {
    const [zone] = await tx.$queryRaw<{ photoPath: string | null }[]>`
      SELECT photo_path AS "photoPath" FROM cave_zone WHERE id = ${id} AND cave_id = ${caveId} AND archived_at IS NULL FOR UPDATE`;
    if (!zone) throw new NotFoundException(ZONE_NOT_FOUND);
    return zone;
  }

  /**
   * Photo de la zone (remplace la précédente) : normalisée comme les photos
   * d'étiquette, 1600 px au plus, JPEG. Écrite dans un fichier temporaire, puis
   * mise en place (rename, atomique) et enregistrée sous verrou de la zone : une
   * suppression simultanée passe avant (404, fichier temporaire effacé) ou après
   * (elle voit la photo et l'efface), jamais de fichier orphelin ni à moitié écrit.
   */
  async setPhoto(caveId: string, id: string, input: Buffer): Promise<ZoneView> {
    await this.findOwn(caveId, id);
    let buffer: Buffer;
    try {
      ({ buffer } = await this.normalization.normalize(input));
    } catch {
      throw new BadRequestException('Image illisible ou format non pris en charge');
    }
    const path = zonePhotoPath(id);
    const tmp = join(this.dir, 'zones', `${id}.${randomUUID()}.tmp`);
    await mkdir(join(this.dir, 'zones'), { recursive: true });
    await writeFile(tmp, buffer);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockOwn(tx, caveId, id);
        await rename(tmp, join(this.dir, path));
        await tx.caveZone.update({ where: { id }, data: { photoPath: path } });
      });
    } finally {
      await unlinkIgnoringMissing(tmp);
    }
    return zoneView(await this.findOwn(caveId, id));
  }

  /** Retire la photo, sous verrou de la zone : un envoi simultané passe entièrement avant ou après. */
  async removePhoto(caveId: string, id: string): Promise<ZoneView> {
    await this.prisma.$transaction(async (tx) => {
      const zone = await this.lockOwn(tx, caveId, id);
      await tx.caveZone.update({ where: { id }, data: { photoPath: null } });
      if (zone.photoPath) await unlinkIgnoringMissing(join(this.dir, zone.photoPath));
    });
    return zoneView(await this.findOwn(caveId, id));
  }

  /**
   * Image de la photo, pour tout compte qui a accès à la cave de la zone
   * (propriétaire ou membre, cave courante ou non). Sinon la zone est « introuvable ».
   */
  async readPhoto(userId: string, id: string): Promise<Buffer> {
    const zone = await this.prisma.caveZone.findUnique({ where: { id } });
    if (!zone || !(await this.caves.findAccess(userId, zone.caveId))) throw new NotFoundException(ZONE_NOT_FOUND);
    if (!zone.photoPath) throw new NotFoundException(ZONE_PHOTO_NOT_FOUND);
    try {
      return await readFile(join(this.dir, zone.photoPath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException(ZONE_PHOTO_NOT_FOUND);
      throw e;
    }
  }
}
