import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PairingModule } from '../pairing/pairing.module';
import { WinesModule } from '../wines/wines.module';
import { MovementsController } from './movements.controller';
import { MovementsService } from './movements.service';

@Module({ imports: [AuthModule, PairingModule, WinesModule], controllers: [MovementsController], providers: [MovementsService], exports: [MovementsService] })
export class MovementsModule {}
