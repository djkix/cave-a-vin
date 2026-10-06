import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PairingModule } from '../pairing/pairing.module';
import { QueueModule } from '../queue/queue.module';
import { VisionModule } from '../vision/vision.module';
import { ProducerProcessor } from './producer.processor';
import { ProducersController } from './producers.controller';
import { ProducerScheduler, ProducersService } from './producers.service';

/** La file `wine-pairing` (et sa fermeture) appartient à PairingModule : on la réutilise. */
@Module({
  imports: [AuthModule, QueueModule, VisionModule, PairingModule],
  controllers: [ProducersController],
  providers: [ProducerScheduler, ProducersService, ProducerProcessor],
  exports: [ProducerScheduler, ProducerProcessor],
})
export class ProducersModule {}
