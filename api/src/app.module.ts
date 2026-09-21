import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AppellationsModule } from './appellations/appellations.module';
import { AuthModule } from './auth/auth.module';
import { ExportModule } from './export/export.module';
import { HealthController } from './health/health.controller';
import { MovementsModule } from './movements/movements.module';
import { PhotosModule } from './photos/photos.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { WinesModule } from './wines/wines.module';

// Pas de garde globale : seules les routes coûteuses ou sensibles (upload de photo,
// connexion locale) portent ThrottlerGuard, avec leur propre plafond.
@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    AdminModule,
    AppellationsModule,
    WinesModule,
    PhotosModule,
    QueueModule,
    MovementsModule,
    ExportModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
