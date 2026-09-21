import { Module } from '@nestjs/common';
import { AppellationsModule } from './appellations/appellations.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { PhotosModule } from './photos/photos.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { WinesModule } from './wines/wines.module';

@Module({
  imports: [PrismaModule, AuthModule, AppellationsModule, WinesModule, PhotosModule, QueueModule],
  controllers: [HealthController],
})
export class AppModule {}
