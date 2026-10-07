import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { QueueModule } from '../queue/queue.module';
import { AdminBudgetController, AdminController, AdminRegistrationsController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, CavesModule, QueueModule],
  controllers: [AdminController, AdminRegistrationsController, AdminBudgetController],
  providers: [AdminService],
})
export class AdminModule {}
