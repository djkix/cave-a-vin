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
});
