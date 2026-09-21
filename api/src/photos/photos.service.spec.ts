import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      findMany: async () => photos,
    },
  };
}

describe('PhotosService.ingest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cave-photos-'));

  it('stores original + normalized and creates a PENDING row', async () => {
    const prisma = fakePrisma();
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir);
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const { photo, duplicate } = await service.ingest(img, 'image/jpeg');
    expect(duplicate).toBe(false);
    expect(photo.status).toBe('PENDING');
    expect(existsSync(join(dir, 'original', `${photo.id}.jpg`))).toBe(true);
    expect(existsSync(join(dir, 'normalized', `${photo.id}.jpg`))).toBe(true);
  });

  it('returns the existing row for the same bytes', async () => {
    const prisma = fakePrisma();
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir);
    const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#111' } }).jpeg().toBuffer();
    const a = await service.ingest(img, 'image/jpeg');
    const b = await service.ingest(img, 'image/jpeg');
    expect(b.duplicate).toBe(true);
    expect(b.photo.id).toBe(a.photo.id);
    expect(prisma.photos).toHaveLength(1);
  });
});
