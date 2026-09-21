import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { loadEnv } from '../config/env';
import { closeQueue, createExtractionQueue, EXTRACTION_QUEUE_TOKEN, ExtractionJobData } from '../queue/extraction.queue';
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
export class PhotosModule implements OnModuleDestroy {
  constructor(@Inject(EXTRACTION_QUEUE_TOKEN) private readonly queue: Queue<ExtractionJobData>) {}

  // La file BullMQ tient une connexion Redis créée hors du cycle de vie Nest :
  // sans cette fermeture, `app.close()` laisse le process (et Jest) en vie.
  async onModuleDestroy() {
    await closeQueue(this.queue);
  }
}
