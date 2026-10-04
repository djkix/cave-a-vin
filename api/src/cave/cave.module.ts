import { Module } from '@nestjs/common';
import { ApogeeModule } from '../apogee/apogee.module';
import { AuthModule } from '../auth/auth.module';
import { MovementsModule } from '../movements/movements.module';
import { CaveController } from './cave.controller';
import { CaveService } from './cave.service';

@Module({ imports: [AuthModule, MovementsModule, ApogeeModule], controllers: [CaveController], providers: [CaveService] })
export class CaveModule {}
