import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PAIRING_QUEUE_TOKEN, WinePairingJobData } from '../pairing/pairing.queue';
import { PrismaService } from '../prisma/prisma.service';
import { producerKeyOf } from './producer-key';
import { PRODUCER_PROFILE_INCLUDE, producerProfileOf, ProducerProfileView } from './producer-profile.view';
import { findProducerWines } from './producer-wines';
import { scheduleProducer } from './producer.queue';

/** Voir PairingService : au-delà, on répond quand même, la reprise du worker prendra le relais. */
const SCHEDULE_TIMEOUT_MS = 3000;

@Injectable()
export class ProducerScheduler {
  constructor(
    @Inject(PAIRING_QUEUE_TOKEN) private readonly queue: Queue<WinePairingJobData>,
    private readonly prisma: PrismaService,
  ) {}

  schedule(producerKey: string): Promise<void> {
    return scheduleProducer(this.queue, producerKey);
  }

  /** Nouveau vin : on ne demande le descriptif que si son domaine n'en a pas encore. */
  async scheduleIfMissing(producer: string): Promise<void> {
    const key = producerKeyOf(producer);
    if (!key) return;
    if (await this.prisma.producerProfile.findUnique({ where: { producerKey: key }, select: { id: true } })) return;
    await this.schedule(key);
  }
}

@Injectable()
export class ProducersService {
  private readonly logger = new Logger(ProducersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ProducerScheduler,
  ) {}

  /** Nom du domaine tel que vu la première fois ; 404 si aucun vin ne porte cette clé. */
  private async displayNameOf(producerKey: string): Promise<string> {
    const wines = await findProducerWines(this.prisma, producerKey);
    if (!wines.length) throw new NotFoundException('Domaine introuvable');
    return wines[0].producer;
  }

  /** Texte saisi à la main : il prime, le worker ne le remplace jamais. */
  async setDescription(producerKey: string, description: string, userId: string): Promise<ProducerProfileView | null> {
    const displayName = await this.displayNameOf(producerKey);
    const manual = { status: 'DONE' as const, source: 'MANUEL', description, errorMessage: null, updatedById: userId };
    const saved = await this.prisma.producerProfile.upsert({
      where: { producerKey },
      create: { producerKey, displayName, ...manual },
      update: manual,
      include: PRODUCER_PROFILE_INCLUDE,
    });
    return producerProfileOf(saved);
  }

  /** Régénérer, ou « Revenir au texte généré » depuis un texte manuel : repasse en attente côté Gemini. */
  async regenerate(producerKey: string): Promise<void> {
    const displayName = await this.displayNameOf(producerKey);
    await this.prisma.producerProfile.upsert({
      where: { producerKey },
      create: { producerKey, displayName },
      update: { status: 'PENDING', source: 'GEMINI', description: null, errorMessage: null, updatedById: null },
    });

    // Redis indisponible : schedule() peut ne jamais se résoudre. La ligne est déjà
    // PENDING et la reprise au démarrage du worker la remettra en file.
    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        this.logger.warn(`Planification du descriptif « ${producerKey} » toujours en cours après ${SCHEDULE_TIMEOUT_MS} ms : réponse envoyée sans attendre, la reprise du worker prendra le relais si besoin`);
        resolve();
      }, SCHEDULE_TIMEOUT_MS);
    });
    await Promise.race([this.scheduler.schedule(producerKey), timeout]);
    clearTimeout(timeoutId!);
  }
}
