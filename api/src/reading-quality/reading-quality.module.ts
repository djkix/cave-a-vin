import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReadingQualityController } from './reading-quality.controller';
import { ReadingQualityService } from './reading-quality.service';

@Module({ imports: [AuthModule], controllers: [ReadingQualityController], providers: [ReadingQualityService] })
export class ReadingQualityModule {}
