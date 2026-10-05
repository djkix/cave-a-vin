import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PhotosService } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { VISION_PROVIDER, VisionProvider } from '../vision/vision-provider.interface';
import { EXIT_ATTEMPTS, EXTRACTION_ATTEMPTS } from './extraction.queue';
import { deferralReason, isTransientVisionFailure } from './transient-failure';
import { VisionBudgetService } from './vision-budget.service';

@Injectable()
export class ExtractionProcessor {
  private readonly logger = new Logger(ExtractionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    private readonly budget: VisionBudgetService,
  ) {}

  async process(photoId: string, isLastAttempt = true): Promise<void> {
    // Une entrée analysée par lot ne doit jamais être traitée ici : le seul cas où
    // ce travail existe encore pour une photo ENTRY est la bascule rare d'une
    // photo de sortie reprise en entrée (mêmes octets) après la mise en file de
    // son travail de sortie. On lit la photo sans la modifier avant de décider.
    const current = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (current?.purpose === 'ENTRY') {
      this.logger.log(`Photo ${photoId} ignorée : analyse par lot`);
      return;
    }

    const photo = await this.prisma.photo.update({ where: { id: photoId }, data: { status: 'PROCESSING' } });
    const attempts = photo.purpose === 'EXIT' ? EXIT_ATTEMPTS : EXTRACTION_ATTEMPTS;
    try {
      await this.budget.assertUnderCap();
      const image = await this.photos.readNormalized(photoId);
      const result = await this.vision.extractWineLabel(image, 'image/jpeg');
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'DONE',
          rawExtraction: result.raw as Prisma.InputJsonValue,
          model: result.model,
          latencyMs: result.latencyMs,
          costCents: result.costCents,
          errorMessage: null,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const transient = isTransientVisionFailure(e);
      this.logger.warn(`Extraction ${photoId} ${transient ? 'reportée' : 'échouée'} : ${message}`);

      // Panne passagère : la photo retourne en attente, pas en échec. Elle reste
      // visible dans le compteur d'attente et le worker la reprend après le délai
      // de reprise — c'est ce qui permet de photographier sans se soucier de la
      // disponibilité de Gemini.
      if (transient && !isLastAttempt) {
        await this.prisma.photo.update({
          where: { id: photoId },
          data: { status: 'PENDING', errorMessage: deferralReason(e) },
        });
        throw e;
      }

      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'FAILED', errorMessage: transient ? `${deferralReason(e)} — abandon après ${attempts} tentatives` : message },
      });

      // Erreur définitive (sortie du modèle inexploitable, clé d'API invalide) :
      // on coupe la file tout de suite. Sans ce signal, BullMQ rejouerait mille
      // fois un appel dont on sait qu'il échouera, et l'écran n'afficherait la
      // saisie manuelle que des jours plus tard.
      throw transient ? e : new UnrecoverableError(message);
    }
  }
}
