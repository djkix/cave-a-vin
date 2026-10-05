import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { PairingController } from './pairing.controller';
import { PairingProcessor } from './pairing.processor';
import { closePairingQueue, createPairingQueue, PAIRING_QUEUE_TOKEN, PairingJobData } from './pairing.queue';
import { PairingScheduler, PairingService } from './pairing.service';

@Module({
  imports: [AuthModule, QueueModule, VisionModule],
  controllers: [PairingController],
  providers: [{ provide: PAIRING_QUEUE_TOKEN, useFactory: createPairingQueue }, PairingScheduler, PairingService, PairingProcessor],
  exports: [PAIRING_QUEUE_TOKEN, PairingScheduler, PairingProcessor],
})
export class PairingModule implements OnModuleDestroy {
  constructor(@Inject(PAIRING_QUEUE_TOKEN) private readonly queue: Queue<PairingJobData>) {}

  async onModuleDestroy() {
    await closePairingQueue(this.queue);
  }
}
