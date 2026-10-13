import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CaveContextService } from '../caves/cave-context.service';
import { ImageNormalizationService } from '../photos/image-normalization.service';
import { PHOTO_STORAGE_DIR } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_MAX_SIDE, PLAN_NOT_FOUND, PlanMarker, PlanMeta, planPath } from './zone';
import { placeImage, unlinkIgnoringMissing } from './zones.service';

const meta = (c: { planWidth: number | null; planHeight: number | null; planUpdatedAt: Date | null }): PlanMeta =>
  ({ width: c.planWidth!, height: c.planHeight!, updatedAt: c.planUpdatedAt!.toISOString() });

/**
 * Plan de la cave : une image (photo de la pièce ou d'un schéma), au plus une
 * par cave, sur laquelle les zones portent leur repère. Les repères sont gardés
 * quand le plan est retiré : un plan équivalent peut revenir.
 */
@Injectable()
export class PlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalization: ImageNormalizationService,
    private readonly caves: CaveContextService,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
  ) {}

  /** Plan et repères des zones non archivées, numérotés dans l'ordre d'affichage ; aucun repère sans plan. */
  async read(caveId: string): Promise<{ plan: PlanMeta | null; markers: PlanMarker[] }> {
    const cave = await this.prisma.cave.findUniqueOrThrow({ where: { id: caveId } });
    if (!cave.planPath) return { plan: null, markers: [] };
    const zones = await this.prisma.caveZone.findMany({
      where: { caveId, archivedAt: null, planX: { not: null }, planY: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return { plan: meta(cave), markers: zones.map((z, i) => ({ zoneId: z.id, name: z.name, number: i + 1, x: z.planX!, y: z.planY! })) };
  }

  /**
   * Nouveau plan (remplace le précédent) : redressé selon l'EXIF, 2400 px au
   * plus sur le grand côté, JPEG. Mis en place (rename) et enregistré sous
   * verrou de la cave : deux envois simultanés passent l'un après l'autre, le
   * fichier est toujours celui qu'enregistre la base.
   */
  async set(caveId: string, input: Buffer): Promise<PlanMeta> {
    const path = planPath(caveId);
    let saved: PlanMeta | undefined;
    await placeImage(this.normalization.normalize(input, { maxSide: PLAN_MAX_SIDE }), this.dir, path, (place, size) =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM cave WHERE id = ${caveId} FOR UPDATE`;
        await place();
        saved = meta(await tx.cave.update({
          where: { id: caveId }, data: { planPath: path, planWidth: size.width, planHeight: size.height, planUpdatedAt: new Date() },
        }));
      }));
    return saved!;
  }

  /**
   * Retire le plan (taille, puis fichier), sous verrou de la cave ; les repères
   * des zones sont gardés. Sans plan : rien. Le fichier n'est effacé qu'une fois
   * la transaction validée : un échec de l'écriture en base ne laisse jamais un
   * plan enregistré sans son image.
   */
  async remove(caveId: string): Promise<void> {
    const removed = await this.prisma.$transaction(async (tx) => {
      const [cave] = await tx.$queryRaw<{ planPath: string | null }[]>`SELECT plan_path AS "planPath" FROM cave WHERE id = ${caveId} FOR UPDATE`;
      if (!cave?.planPath) return null;
      await tx.cave.update({ where: { id: caveId }, data: { planPath: null, planWidth: null, planHeight: null, planUpdatedAt: null } });
      return cave.planPath;
    });
    if (!removed) return;
    // Effacé sous un nouveau verrou, et seulement si la cave n'a toujours pas de
    // plan : un envoi validé entre-temps (même chemin) garde son image.
    await this.prisma.$transaction(async (tx) => {
      const [cave] = await tx.$queryRaw<{ planPath: string | null }[]>`SELECT plan_path AS "planPath" FROM cave WHERE id = ${caveId} FOR UPDATE`;
      if (cave && !cave.planPath) await unlinkIgnoringMissing(join(this.dir, removed));
    });
  }

  /** Image du plan, pour tout compte qui a accès à la cave (cave courante ou non) ; sinon « Plan introuvable ». */
  async image(userId: string, caveId: string): Promise<Buffer> {
    if (!(await this.caves.findAccess(userId, caveId))) throw new NotFoundException(PLAN_NOT_FOUND);
    const cave = await this.prisma.cave.findUnique({ where: { id: caveId }, select: { planPath: true } });
    if (!cave?.planPath) throw new NotFoundException(PLAN_NOT_FOUND);
    try {
      return await readFile(join(this.dir, cave.planPath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException(PLAN_NOT_FOUND);
      throw e;
    }
  }
}
