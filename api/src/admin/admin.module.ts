import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { AdminBudgetController, AdminController, AdminGeminiUsageController, AdminRegistrationsController } from './admin.controller';
import { AdminService } from './admin.service';
import { GeminiUsageService } from './gemini-usage.service';

@Module({
  imports: [AuthModule, CavesModule, QueueModule, VisionModule],
  controllers: [AdminController, AdminRegistrationsController, AdminBudgetController, AdminGeminiUsageController],
  providers: [AdminService, GeminiUsageService],
})
export class AdminModule {}
