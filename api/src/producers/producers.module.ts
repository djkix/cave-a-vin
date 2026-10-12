import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { ProducerBatchProcessor } from './producer-batch.processor';
import { ProducersController } from './producers.controller';
import { ProducerScheduler, ProducersService } from './producers.service';

@Module({
  imports: [AuthModule, QueueModule, VisionModule],
  controllers: [ProducersController],
  providers: [ProducerScheduler, ProducersService, ProducerBatchProcessor],
  exports: [ProducerScheduler, ProducerBatchProcessor],
})
export class ProducersModule {}
