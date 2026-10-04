import { Module } from '@nestjs/common';
import { ApogeeModule } from '../apogee/apogee.module';
import { AuthModule } from '../auth/auth.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

@Module({ imports: [AuthModule, ApogeeModule], controllers: [ExportController], providers: [ExportService] })
export class ExportModule {}
