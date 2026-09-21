import { Module } from '@nestjs/common';
import { AppellationsModule } from './appellations/appellations.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { WinesModule } from './wines/wines.module';

@Module({
  imports: [PrismaModule, AuthModule, AppellationsModule, WinesModule],
  controllers: [HealthController],
})
export class AppModule {}
