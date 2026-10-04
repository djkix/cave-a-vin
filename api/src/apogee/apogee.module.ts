import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApogeeAdminController } from './apogee-admin.controller';
import { ApogeeAdminService } from './apogee-admin.service';
import { ApogeeRulesService } from './apogee-rules.service';

@Module({
  imports: [AuthModule],
  controllers: [ApogeeAdminController],
  providers: [ApogeeRulesService, ApogeeAdminService],
  exports: [ApogeeRulesService],
})
export class ApogeeModule {}
