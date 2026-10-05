import { Module } from '@nestjs/common';
import { ApogeeModule } from '../apogee/apogee.module';
import { AuthModule } from '../auth/auth.module';
import { CaveModule } from '../cave/cave.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({ imports: [AuthModule, CaveModule, ApogeeModule], controllers: [StatsController], providers: [StatsService] })
export class StatsModule {}
