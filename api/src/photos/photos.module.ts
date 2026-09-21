import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadEnv } from '../config/env';
import { createExtractionQueue, EXTRACTION_QUEUE_TOKEN } from '../queue/extraction.queue';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotoEventsController } from './photo-events.controller';
import { PhotosController } from './photos.controller';
import { PHOTO_STORAGE_DIR, PhotosService } from './photos.service';

@Module({
  imports: [AuthModule],
  controllers: [PhotosController, PhotoEventsController],
  providers: [
    PhotosService,
    ImageNormalizationService,
    { provide: PHOTO_STORAGE_DIR, useFactory: () => loadEnv().PHOTO_STORAGE_DIR },
    { provide: EXTRACTION_QUEUE_TOKEN, useFactory: createExtractionQueue },
  ],
  exports: [PhotosService, EXTRACTION_QUEUE_TOKEN],
})
export class PhotosModule {}
