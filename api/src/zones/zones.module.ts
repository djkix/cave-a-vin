import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { loadEnv } from '../config/env';
import { ImageNormalizationService } from '../photos/image-normalization.service';
import { PHOTO_STORAGE_DIR } from '../photos/photos.service';
import { CurrentCaveZonesController, ZonePhotoController } from './zones.controller';
import { ZonesService } from './zones.service';

@Module({
  imports: [AuthModule, CavesModule],
  controllers: [CurrentCaveZonesController, ZonePhotoController],
  providers: [ZonesService, ImageNormalizationService, { provide: PHOTO_STORAGE_DIR, useFactory: () => loadEnv().PHOTO_STORAGE_DIR }],
})
export class ZonesModule {}
