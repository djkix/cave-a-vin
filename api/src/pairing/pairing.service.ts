import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PAIRING_QUEUE_TOKEN, raceScheduleWithTimeout, WinePairingJobData, schedulePairing } from './pairing.queue';

/** Au-delà, on répond quand même (202) : la ligne est déjà PENDING et la reprise au
 * démarrage du worker régénérera l'accord si la planification n'a jamais abouti. */
const SCHEDULE_TIMEOUT_MS = 3000;

@Injectable()
export class PairingScheduler {
  constructor(@Inject(PAIRING_QUEUE_TOKEN) private readonly queue: Queue<WinePairingJobData>) {}

  schedule(wineId: string): Promise<void> {
    return schedulePairing(this.queue, wineId);
  }
}

@Injectable()
export class PairingService {
  private readonly logger = new Logger(PairingService.name);

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

    await raceScheduleWithTimeout(this.scheduler.schedule(wineId), SCHEDULE_TIMEOUT_MS, () =>
      this.logger.warn(`Planification de l'accord ${wineId} toujours en cours après ${SCHEDULE_TIMEOUT_MS} ms : réponse envoyée sans attendre, la reprise du worker prendra le relais si besoin`),
    );
  }
}
