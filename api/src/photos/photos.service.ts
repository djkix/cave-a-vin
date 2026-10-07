import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { Photo, PhotoPurpose, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { EXTRACTION_QUEUE_TOKEN, ExtractionJobData, jobOptionsFor } from '../queue/extraction.queue';
import { parseExtraction, safeParseExtraction } from '../vision/extraction-schema';
import { buildDisplayImage, displayFileName } from './display-image';
import { ImageNormalizationService } from './image-normalization.service';

export const PHOTO_STORAGE_DIR = 'PHOTO_STORAGE_DIR';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ENQUEUE_TIMEOUT_MS = 5000;

async function unlinkIgnoringMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly normalization: ImageNormalizationService,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
    @Inject(EXTRACTION_QUEUE_TOKEN) private readonly queue: Pick<Queue<ExtractionJobData>, 'add'>,
  ) {}

  /**
   * Photo envoyée dans la cave `caveId` (cave courante du propriétaire). Doublon
   * cherché dans la cave : deux caves peuvent envoyer la même image et ont
   * chacune leur photo (fichiers nommés par identifiant de photo, jamais
   * partagés sur le disque).
   */
  async ingest(caveId: string, input: Buffer, mimeType: string, purpose: PhotoPurpose = 'ENTRY'): Promise<{ photo: Photo; duplicate: boolean }> {
    const contentHash = createHash('sha256').update(input).digest('hex');
    const existing = await this.prisma.photo.findUnique({ where: { caveId_contentHash: { caveId, contentHash } } });
    if (existing) return { photo: await this.reclaimForEntry(existing, purpose), duplicate: true };

    let buffer: Buffer;
    try {
      ({ buffer } = await this.normalization.normalize(input));
    } catch {
      throw new BadRequestException('Image illisible ou format non pris en charge');
    }

    const id = randomUUID();
    const ext = EXT[mimeType] ?? 'bin';
    const normalizedPath = join('normalized', `${id}.jpg`);
    const originalAbsolutePath = join(this.dir, 'original', `${id}.${ext}`);
    const normalizedAbsolutePath = join(this.dir, normalizedPath);
    await mkdir(join(this.dir, 'original'), { recursive: true });
    await mkdir(join(this.dir, 'normalized'), { recursive: true });
    await writeFile(originalAbsolutePath, input);
    await writeFile(normalizedAbsolutePath, buffer);

    let photo: Photo;
    try {
      photo = await this.prisma.photo.create({
        data: { id, caveId, contentHash, storagePath: normalizedPath, mimeType: 'image/jpeg', purpose },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await unlinkIgnoringMissing(originalAbsolutePath);
        await unlinkIgnoringMissing(normalizedAbsolutePath);
        const existingAfterRace = await this.prisma.photo.findUnique({ where: { caveId_contentHash: { caveId, contentHash } } });
        if (existingAfterRace) return { photo: await this.reclaimForEntry(existingAfterRace, purpose), duplicate: true };
      }
      throw e;
    }

    // L'analyse d'entrée se fait désormais par lot, directement depuis la table
    // photo (voir worker de rafale) : créer un travail BullMQ ici ferait analyser
    // la photo deux fois. Seule la sortie (EXIT) garde un travail immédiat,
    // puisque l'utilisateur est devant la bouteille et attend le résultat.
    if (purpose === 'EXIT') {
      try {
        await this.enqueueWithTimeout(photo.id, purpose);
      } catch (e) {
        this.logger.warn(`Mise en file d'attente impossible pour la photo ${photo.id} : ${(e as Error).message}`);
        await this.prisma.photo.delete({ where: { id: photo.id } });
        await unlinkIgnoringMissing(originalAbsolutePath);
        await unlinkIgnoringMissing(normalizedAbsolutePath);
        throw new ServiceUnavailableException('File de traitement indisponible, réessayez dans un instant');
      }
    }

    return { photo, duplicate: false };
  }

  /**
   * Mêmes octets envoyés en entrée qu'une ancienne photo de sortie restée sans
   * mouvement : sans cette bascule, la photo garderait purpose = EXIT et
   * disparaîtrait de la revue groupée comme du bandeau d'attente — une photo
   * n'est jamais perdue. Une photo de sortie qui a déjà débité le stock reste
   * une sortie. Si elle n'est pas encore analysée, elle suit le parcours
   * d'entrée, mais son job garde les options de file de sortie déjà choisies
   * (deux tentatives, sans report) : c'est acceptable, le cas est rare (mêmes
   * octets exactement) et ne coûte au pire qu'un report en moins.
   */
  private async reclaimForEntry(photo: Photo, purpose: PhotoPurpose): Promise<Photo> {
    if (purpose !== 'ENTRY' || photo.purpose !== 'EXIT') return photo;
    // updateMany : la condition « aucun mouvement » est vérifiée par la base au
    // moment de l'écriture, pas sur la ligne lue un instant plus tôt.
    const { count } = await this.prisma.photo.updateMany({
      where: { id: photo.id, purpose: 'EXIT', movements: { none: {} } },
      data: { purpose: 'ENTRY' },
    });
    if (count === 0) return photo;
    return (await this.prisma.photo.findUnique({ where: { id: photo.id } })) ?? photo;
  }

  private async enqueueWithTimeout(photoId: string, purpose: PhotoPurpose): Promise<void> {
    let timer!: NodeJS.Timeout;
    try {
      await Promise.race([
        this.queue.add('extract', { photoId }, { jobId: photoId, ...jobOptionsFor(purpose) }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ENQUEUE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Photo par identifiant, **sans filtre de cave**. L'appelant doit vérifier
   * l'accès du compte à `photo.caveId` (`CaveContextService.findAccess`) avant
   * de rendre quoi que ce soit, et répondre 404 sans accès. Dans une route de
   * cave, préférer `findInCave`.
   */
  async findById(id: string): Promise<Photo> {
    const photo = await this.prisma.photo.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    return photo;
  }

  /** Photo de la cave `caveId` ; celle d'une autre cave est traitée comme inexistante (404). */
  async findInCave(caveId: string, id: string): Promise<Photo> {
    const photo = await this.prisma.photo.findFirst({ where: { id, caveId } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    return photo;
  }

  async readNormalized(id: string): Promise<Buffer> {
    return readFile(join(this.dir, 'normalized', `${id}.jpg`));
  }

  /**
   * Version d'affichage (vignettes, écrans de confirmation) : recadrée sur
   * l'étiquette et retouchée, fabriquée à la première demande puis gardée dans
   * `normalized/<id>.display-v2.jpg` (nom versionné, voir `displayFileName`). Seulement pour une photo lue (DONE) ou en
   * échec (FAILED) : avant la lecture, le cadre de l'étiquette n'est pas connu,
   * l'image d'origine est rendue sans rien garder. Une fabrication ratée ne
   * prive jamais l'utilisateur de sa photo : l'image d'origine est rendue.
   * Gemini, lui, lit toujours l'image d'origine (`readNormalized`).
   */
  async readDisplay(id: string): Promise<Buffer> {
    const photo = await this.findById(id);
    if (photo.status !== 'DONE' && photo.status !== 'FAILED') return this.readNormalized(id);

    const displayPath = join(this.dir, 'normalized', displayFileName(id));
    try {
      return await readFile(displayPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    const original = await this.readNormalized(id);
    let display: Buffer;
    try {
      display = await buildDisplayImage(original, safeParseExtraction(photo.rawExtraction)?.labelBox ?? null);
    } catch (e) {
      this.logger.error(`Version d'affichage impossible pour la photo ${id} : ${(e as Error).message}`);
      return original;
    }
    // Écriture puis renommage : une lecture concurrente ne voit jamais un fichier à moitié écrit.
    const tmpPath = `${displayPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, display);
      await rename(tmpPath, displayPath);
    } catch (e) {
      await unlinkIgnoringMissing(tmpPath).catch(() => undefined);
      this.logger.error(`Version d'affichage non gardée pour la photo ${id} : ${(e as Error).message}`);
    }
    return display;
  }

  /**
   * État de la file d'analyse, pour que l'utilisateur sache que ses photos sont
   * stockées et attendent leur tour. Sans ce compteur, une photo reportée est
   * invisible : elle n'apparaît ni dans la revue groupée (qui ne liste que les
   * analyses terminées) ni dans le journal, et elle passe pour perdue.
   */
  async queueStatus(caveId: string): Promise<{ waiting: number; oldestWaitingAt: Date | null; lastReason: string | null }> {
    // Une photo écartée n'est plus analysée : elle ne compte pas dans l'attente.
    const where: Prisma.PhotoWhereInput = { caveId, status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'ENTRY', dismissedAt: null };
    const [waiting, oldest, lastDeferred] = await Promise.all([
      this.prisma.photo.count({ where }),
      this.prisma.photo.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.photo.findFirst({
        where: { ...where, errorMessage: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { errorMessage: true },
      }),
    ]);
    return { waiting, oldestWaitingAt: oldest?.createdAt ?? null, lastReason: lastDeferred?.errorMessage ?? null };
  }

  listPendingReview(caveId: string): Promise<Photo[]> {
    return this.prisma.photo.findMany({
      // Une photo de sortie analysée n'est pas un vin à rentrer, une photo
      // écartée ne doit pas réapparaître dans la revue groupée.
      where: { caveId, status: 'DONE', purpose: 'ENTRY', movements: { none: {} }, dismissedAt: null },
      orderBy: { createdAt: 'asc' },
      // La revue groupée est un écran de téléphone : au-delà de 200 fiches la
      // réponse (extractions JSON incluses) devient inutilisable.
      take: 200,
    });
  }

  /**
   * Écran « À confirmer » : toutes les photos d'entrée encore sans mouvement et
   * non écartées, réparties par état. `toConfirm` porte l'extraction déjà
   * analysée (même logique que `listPendingReview` : `null` si illisible),
   * pour que l'écran de confirmation n'ait pas de second aller-retour à faire.
   */
  async entryInbox(caveId: string): Promise<{
    toConfirm: (Photo & { extraction: ReturnType<typeof parseExtraction> | null })[];
    inProgress: Photo[];
    failed: Photo[];
  }> {
    const base: Prisma.PhotoWhereInput = { caveId, purpose: 'ENTRY', movements: { none: {} }, dismissedAt: null };
    const [toConfirmRows, inProgress, failed] = await Promise.all([
      this.prisma.photo.findMany({ where: { ...base, status: 'DONE' }, orderBy: { createdAt: 'asc' }, take: 200 }),
      this.prisma.photo.findMany({ where: { ...base, status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { createdAt: 'asc' }, take: 200 }),
      this.prisma.photo.findMany({ where: { ...base, status: 'FAILED' }, orderBy: { createdAt: 'asc' }, take: 200 }),
    ]);
    const toConfirm = toConfirmRows.map((p) => ({ ...p, extraction: safeParseExtraction(p.rawExtraction) }));
    return { toConfirm, inProgress, failed };
  }

  /**
   * Écarte une photo d'entrée qui n'a servi à aucune entrée en stock : l'utilisateur
   * ne veut pas de ce vin ou s'est trompé de prise. Interdit si un mouvement
   * référence déjà la photo (409), pour ne jamais décrocher une preuve d'achat
   * d'une entrée déjà faite.
   */
  async dismiss(caveId: string, id: string): Promise<void> {
    const photo = (await this.prisma.photo.findFirst({ where: { id, caveId }, include: { movements: true } })) as
      | (Photo & { movements: unknown[] })
      | null;
    if (!photo) throw new NotFoundException('Photo introuvable');
    if (photo.movements.length > 0) throw new ConflictException('Photo déjà utilisée par une entrée');
    await this.prisma.photo.update({ where: { id }, data: { dismissedAt: new Date() } });
  }
}
