import sharp from 'sharp';
import { ImageNormalizationService } from './image-normalization.service';

describe('ImageNormalizationService', () => {
  const service = new ImageNormalizationService();

  it('downsizes to 1600px max width, JPEG, and strips metadata', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#803030' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'test' } } })
      .toBuffer();
    const out = await service.normalize(big);
    const meta = await sharp(out.buffer).metadata();
    expect(out.width).toBe(1600);
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });

  it('does not upscale small images', async () => {
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
    const out = await service.normalize(small);
    expect(out.width).toBe(800);
  });

  it('maxSide : borne le plus grand côté (portrait comme paysage), sans agrandir', async () => {
    const landscape = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#fff' } }).png().toBuffer();
    const portrait = await sharp({ create: { width: 1000, height: 3000, channels: 3, background: '#fff' } }).png().toBuffer();
    const small = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
    expect(await service.normalize(landscape, { maxSide: 2400 })).toMatchObject({ width: 2400, height: 1200 });
    expect(await service.normalize(portrait, { maxSide: 2400 })).toMatchObject({ width: 800, height: 2400 });
    expect(await service.normalize(small, { maxSide: 2400 })).toMatchObject({ width: 900, height: 600 });
  });

  it('redresse selon l’orientation EXIF : la taille rendue est celle de l’image redressée', async () => {
    // 300 × 100 stockés, orientation 6 (à tourner de 90°) : 100 × 300 une fois redressée.
    const rotated = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#000' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await service.normalize(rotated, { maxSide: 2400 });
    expect(out).toMatchObject({ width: 100, height: 300 });
    expect(await sharp(out.buffer).metadata()).toMatchObject({ width: 100, height: 300 });
  });
});
