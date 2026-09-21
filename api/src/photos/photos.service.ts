import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Photo, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { EXTRACTION_QUEUE_TOKEN, ExtractionJobData } from '../queue/extraction.queue';
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

  async ingest(input: Buffer, mimeType: string): Promise<{ photo: Photo; duplicate: boolean }> {
    const contentHash = createHash('sha256').update(input).digest('hex');
    const existing = await this.prisma.photo.findUnique({ where: { contentHash } });
    if (existing) return { photo: existing, duplicate: true };

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
        data: { id, contentHash, storagePath: normalizedPath, mimeType: 'image/jpeg' },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await unlinkIgnoringMissing(originalAbsolutePath);
        await unlinkIgnoringMissing(normalizedAbsolutePath);
        const existingAfterRace = await this.prisma.photo.findUnique({ where: { contentHash } });
        if (existingAfterRace) return { photo: existingAfterRace, duplicate: true };
      }
      throw e;
    }

    try {
      await this.enqueueWithTimeout(photo.id);
    } catch (e) {
      this.logger.warn(`Mise en file d'attente impossible pour la photo ${photo.id} : ${(e as Error).message}`);
      await this.prisma.photo.delete({ where: { id: photo.id } });
      await unlinkIgnoringMissing(originalAbsolutePath);
      await unlinkIgnoringMissing(normalizedAbsolutePath);
      throw new ServiceUnavailableException('File de traitement indisponible, réessayez dans un instant');
    }

    return { photo, duplicate: false };
  }

  private async enqueueWithTimeout(photoId: string): Promise<void> {
    let timer!: NodeJS.Timeout;
    try {
      await Promise.race([
        this.queue.add('extract', { photoId }, { jobId: photoId }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ENQUEUE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async findById(id: string): Promise<Photo> {
    const photo = await this.prisma.photo.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    return photo;
  }

  async readNormalized(id: string): Promise<Buffer> {
    return readFile(join(this.dir, 'normalized', `${id}.jpg`));
  }

  /**
   * État de la file d'analyse, pour que l'utilisateur sache que ses photos sont
   * stockées et attendent leur tour. Sans ce compteur, une photo reportée est
   * invisible : elle n'apparaît ni dans la revue groupée (qui ne liste que les
   * analyses terminées) ni dans le journal, et elle passe pour perdue.
   */
  async queueStatus(): Promise<{ waiting: number; oldestWaitingAt: Date | null; lastReason: string | null }> {
    const where: Prisma.PhotoWhereInput = { status: { in: ['PENDING', 'PROCESSING'] } };
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

  listPendingReview(): Promise<Photo[]> {
    return this.prisma.photo.findMany({
      where: { status: 'DONE', movements: { none: {} } },
      orderBy: { createdAt: 'asc' },
      // La revue groupée est un écran de téléphone : au-delà de 200 fiches la
      // réponse (extractions JSON incluses) devient inutilisable.
      take: 200,
    });
  }
}
