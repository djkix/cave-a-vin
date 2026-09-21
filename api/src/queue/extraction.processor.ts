import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PhotosService } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { VISION_PROVIDER, VisionProvider } from '../vision/vision-provider.interface';
import { VisionBudgetService } from './vision-budget.service';

@Injectable()
export class ExtractionProcessor {
  private readonly logger = new Logger(ExtractionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async process(photoId: string): Promise<void> {
    await this.prisma.photo.update({ where: { id: photoId }, data: { status: 'PROCESSING' } });
    try {
      await this.budget.assertUnderCap();
      const image = await this.photos.readNormalized(photoId);
      const result = await this.vision.extractWineLabel(image, 'image/jpeg');
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'DONE',
          rawExtraction: result.raw as Prisma.InputJsonValue,
          model: result.model,
          latencyMs: result.latencyMs,
          costCents: result.costCents,
          errorMessage: null,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Extraction ${photoId} échouée : ${message}`);
      await this.prisma.photo.update({ where: { id: photoId }, data: { status: 'FAILED', errorMessage: message } });
      throw e;
    }
  }
}
