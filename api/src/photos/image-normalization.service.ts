import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

@Injectable()
export class ImageNormalizationService {
  /**
   * Redressée selon l'EXIF, réduite (jamais agrandie), JPEG sans métadonnées.
   * Par défaut 1600 px de large au plus (étiquettes, zones) ; `maxSide` borne
   * plutôt le plus grand côté (plan de la cave).
   */
  async normalize(input: Buffer, opts: { maxSide?: number } = {}): Promise<{ buffer: Buffer; width: number; height: number }> {
    const resize = opts.maxSide
      ? { width: opts.maxSide, height: opts.maxSide, fit: 'inside' as const, withoutEnlargement: true }
      : { width: 1600, withoutEnlargement: true };
    const { data, info } = await sharp(input)
      .rotate()
      .resize(resize)
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  }
}
