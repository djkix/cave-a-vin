import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { loadEnv } from '../config/env';
import { PHOTO_STORAGE_DIR } from '../photos/photos.service';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { CandidateStore } from './candidates';
import { ImageSearchController } from './image-search.controller';
import { IMAGE_CANDIDATE_STORE, IMAGE_SEARCH_FETCHER, ImageSearchService } from './image-search.service';
import { safeFetch } from './safe-fetch';

@Module({
  imports: [AuthModule, CavesModule, QueueModule, VisionModule],
  controllers: [ImageSearchController],
  providers: [
    ImageSearchService,
    { provide: PHOTO_STORAGE_DIR, useFactory: () => loadEnv().PHOTO_STORAGE_DIR },
    { provide: IMAGE_SEARCH_FETCHER, useValue: safeFetch },
    {
      provide: IMAGE_CANDIDATE_STORE,
      useFactory: (dir: string, fetcher: typeof safeFetch) => new CandidateStore(dir, fetcher),
      inject: [PHOTO_STORAGE_DIR, IMAGE_SEARCH_FETCHER],
    },
  ],
})
export class ImageSearchModule {}
