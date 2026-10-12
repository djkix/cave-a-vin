import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { PairingBatchProcessor } from './pairing-batch.processor';
import { PairingController } from './pairing.controller';
import { PairingScheduler, PairingService } from './pairing.service';

@Module({
  imports: [AuthModule, CavesModule, QueueModule, VisionModule],
  controllers: [PairingController],
  providers: [PairingScheduler, PairingService, PairingBatchProcessor],
  exports: [PairingScheduler, PairingBatchProcessor],
})
export class PairingModule {}
