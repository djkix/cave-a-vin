import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { PhotosModule } from '../photos/photos.module';
import { VisionModule } from '../vision/vision.module';
import { ExtractionProcessor } from './extraction.processor';
import { VISION_MONTHLY_CAP_CENTS, VisionBudgetService } from './vision-budget.service';

@Module({
  imports: [PhotosModule, VisionModule],
  providers: [
    ExtractionProcessor,
    VisionBudgetService,
    { provide: VISION_MONTHLY_CAP_CENTS, useFactory: () => loadEnv().GEMINI_MONTHLY_CAP_CENTS },
  ],
  exports: [ExtractionProcessor, VisionBudgetService],
})
export class QueueModule {}
