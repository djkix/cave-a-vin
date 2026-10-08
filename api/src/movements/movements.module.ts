import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { LocationsModule } from '../locations/locations.module';
import { PairingModule } from '../pairing/pairing.module';
import { ProducersModule } from '../producers/producers.module';
import { WinesModule } from '../wines/wines.module';
import { MovementsController } from './movements.controller';
import { MovementsService } from './movements.service';

@Module({ imports: [AuthModule, CavesModule, LocationsModule, PairingModule, ProducersModule, WinesModule], controllers: [MovementsController], providers: [MovementsService], exports: [MovementsService] })
export class MovementsModule {}
