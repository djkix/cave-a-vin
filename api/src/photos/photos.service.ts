import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Photo, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { ImageNormalizationService } from './image-normalization.service';

export const PHOTO_STORAGE_DIR = 'PHOTO_STORAGE_DIR';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function unlinkIgnoringMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalization: ImageNormalizationService,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
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

    try {
      const photo = await this.prisma.photo.create({
        data: { id, contentHash, storagePath: normalizedPath, mimeType: 'image/jpeg' },
      });
      return { photo, duplicate: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await unlinkIgnoringMissing(originalAbsolutePath);
        await unlinkIgnoringMissing(normalizedAbsolutePath);
        const existingAfterRace = await this.prisma.photo.findUnique({ where: { contentHash } });
        if (existingAfterRace) return { photo: existingAfterRace, duplicate: true };
      }
      throw e;
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

  listPendingReview(): Promise<Photo[]> {
    return this.prisma.photo.findMany({
      where: { status: 'DONE', movements: { none: {} } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
