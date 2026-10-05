import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PAIRING_QUEUE_TOKEN, PairingJobData, schedulePairing } from './pairing.queue';

@Injectable()
export class PairingScheduler {
  constructor(@Inject(PAIRING_QUEUE_TOKEN) private readonly queue: Queue<PairingJobData>) {}

  schedule(wineId: string): Promise<void> {
    return schedulePairing(this.queue, wineId);
  }
}

@Injectable()
export class PairingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: PairingScheduler,
  ) {}

  async regenerate(wineId: string): Promise<void> {
    const wine = await this.prisma.wine.findUnique({ where: { id: wineId }, select: { id: true } });
    if (!wine) throw new NotFoundException('Vin introuvable');
    await this.prisma.pairing.upsert({
      where: { wineId },
      create: { wineId },
      update: { status: 'PENDING', errorMessage: null },
    });
    await this.scheduler.schedule(wineId);
  }
}
