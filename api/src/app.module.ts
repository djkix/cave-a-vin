import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AppellationsModule } from './appellations/appellations.module';
import { ApogeeModule } from './apogee/apogee.module';
import { AuthModule } from './auth/auth.module';
import { CaveModule } from './cave/cave.module';
import { ExportModule } from './export/export.module';
import { HealthController } from './health/health.controller';
import { ImageSearchModule } from './image-search/image-search.module';
import { MovementsModule } from './movements/movements.module';
import { PairingModule } from './pairing/pairing.module';
import { PhotosModule } from './photos/photos.module';
import { ProducersModule } from './producers/producers.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { ReadingQualityModule } from './reading-quality/reading-quality.module';
import { StatsModule } from './stats/stats.module';
import { WinesModule } from './wines/wines.module';

// Pas de limitation de débit globale : seules les routes coûteuses ou sensibles
// (upload de photo, connexion locale) portent ThrottlerGuard, avec leur propre
// plafond. La seule garde globale est PendingGuard (AuthModule).
@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    AdminModule,
    ReadingQualityModule,
    StatsModule,
    ApogeeModule,
    AppellationsModule,
    WinesModule,
    PhotosModule,
    QueueModule,
    MovementsModule,
    PairingModule,
    ProducersModule,
    ExportModule,
    CaveModule,
    ImageSearchModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
