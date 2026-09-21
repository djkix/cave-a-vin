import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotosService } from './photos.service';

function fakePrisma() {
  const photos: any[] = [];
  return {
    photos,
    photo: {
      findUnique: async ({ where }: any) => photos.find((p) => p.contentHash === where.contentHash || p.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const p = { id: data.id ?? `p${photos.length + 1}`, status: 'PENDING', createdAt: new Date(), ...data };
        photos.push(p);
        return p;
      },
      delete: jest.fn(async ({ where }: any) => {
        const idx = photos.findIndex((p) => p.id === where.id);
        if (idx === -1) throw new Error('not found');
        const [removed] = photos.splice(idx, 1);
        return removed;
      }),
      findMany: async () => photos,
    },
  };
}

describe('PhotosService.ingest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cave-photos-'));

  it('stores original + normalized and creates a PENDING row', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const { photo, duplicate } = await service.ingest(img, 'image/jpeg');
    expect(duplicate).toBe(false);
    expect(photo.status).toBe('PENDING');
    expect(existsSync(join(dir, 'original', `${photo.id}.jpg`))).toBe(true);
    expect(existsSync(join(dir, 'normalized', `${photo.id}.jpg`))).toBe(true);
    expect(queue.add).toHaveBeenCalledWith('extract', { photoId: photo.id }, { jobId: photo.id });
  });

  it('returns the existing row for the same bytes', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#111' } }).jpeg().toBuffer();
    const a = await service.ingest(img, 'image/jpeg');
    const b = await service.ingest(img, 'image/jpeg');
    expect(b.duplicate).toBe(true);
    expect(b.photo.id).toBe(a.photo.id);
    expect(prisma.photos).toHaveLength(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('recovers from a concurrent duplicate create (P2002) by cleaning up files and returning the existing row', async () => {
    const raceDir = mkdtempSync(join(tmpdir(), 'cave-photos-race-'));
    const existingRow = {
      id: 'raced-id',
      contentHash: 'raced-hash',
      status: 'PENDING',
      createdAt: new Date(),
      storagePath: 'normalized/raced-id.jpg',
      mimeType: 'image/jpeg',
    };
    let findUniqueCalls = 0;
    let createCalls = 0;
    const prisma = {
      photo: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return findUniqueCalls === 1 ? null : existingRow;
        },
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        },
        findMany: async () => [],
      },
    };
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), raceDir, queue as any);
    const img = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#222' } }).jpeg().toBuffer();
    const result = await service.ingest(img, 'image/jpeg');
    expect(result.duplicate).toBe(true);
    expect(result.photo).toBe(existingRow);
    expect(createCalls).toBe(1);
    expect(readdirSync(join(raceDir, 'original'))).toHaveLength(0);
    expect(readdirSync(join(raceDir, 'normalized'))).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects an unreadable image with a BadRequestException and creates no row', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    await expect(service.ingest(Buffer.from('not an image'), 'image/jpeg')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.photos).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rolls back the photo row and files, and returns 503, when the queue cannot accept the job', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn(async () => { throw new Error('redis down'); }) };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#333' } }).jpeg().toBuffer();
    await expect(service.ingest(img, 'image/jpeg')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.photo.delete).toHaveBeenCalledTimes(1);
    const deletedId = (prisma.photo.delete as jest.Mock).mock.calls[0][0].where.id;
    expect(prisma.photos).toHaveLength(0);
    expect(readdirSync(join(dir, 'original')).some((f) => f.startsWith(deletedId))).toBe(false);
    expect(readdirSync(join(dir, 'normalized')).some((f) => f.startsWith(deletedId))).toBe(false);
  });
});
