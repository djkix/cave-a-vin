import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadEnv } from '../config/env';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotosController } from './photos.controller';
import { PHOTO_STORAGE_DIR, PhotosService } from './photos.service';

@Module({
  imports: [AuthModule],
  controllers: [PhotosController],
  providers: [
    PhotosService,
    ImageNormalizationService,
    { provide: PHOTO_STORAGE_DIR, useFactory: () => loadEnv().PHOTO_STORAGE_DIR },
  ],
  exports: [PhotosService],
})
export class PhotosModule {}
