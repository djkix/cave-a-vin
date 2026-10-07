import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({ imports: [AuthModule, CavesModule], controllers: [LocationsController], providers: [LocationsService], exports: [LocationsService] })
export class LocationsModule {}
