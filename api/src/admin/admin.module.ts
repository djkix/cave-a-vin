import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { AdminController, AdminRegistrationsController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({ imports: [AuthModule, CavesModule], controllers: [AdminController, AdminRegistrationsController], providers: [AdminService] })
export class AdminModule {}
