import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

@Injectable()
export class ImageNormalizationService {
  async normalize(input: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
    const { data, info } = await sharp(input)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  }
}
