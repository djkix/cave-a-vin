import { GoneException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PHOTO_STORAGE_DIR } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAIRING_BUDGET_SHARE, VisionBudgetExceededError, VisionBudgetService } from '../queue/vision-budget.service';
import { OFFICIAL_SITE_PROVIDER, OfficialSiteProvider } from '../vision/official-site-provider.interface';
import { CandidateExpiredError, CandidateMeta, CandidateStore } from './candidates';
import { readOfficialSiteImages } from './official-site';
import { searchOpenFoodFacts } from './open-food-facts';
import { Fetcher, RemoteImage } from './types';

export const IMAGE_CANDIDATE_STORE = 'IMAGE_CANDIDATE_STORE';
export const IMAGE_SEARCH_FETCHER = 'IMAGE_SEARCH_FETCHER';

const UNAVAILABLE = 'Recherche d’image indisponible pour le moment';

export interface ImageCandidateView {
  id: string;
  source: string;
  sourceUrl: string;
  imageUrl: string;
}

export interface ReferenceImageView {
  referencePhotoId: string | null;
  referencePhotoSource: string | null;
  referencePhotoSourceUrl: string | null;
}

const WINE_SELECT = {
  id: true, producer: true, cuvee: true, appellationRaw: true, vintage: true,
  referencePhotoId: true, referencePhotoPreviousId: true, referencePhotoSource: true, referencePhotoSourceUrl: true,
} satisfies Prisma.WineSelect;

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function viewOf(w: { referencePhotoId: string | null; referencePhotoSource: string | null; referencePhotoSourceUrl: string | null }): ReferenceImageView {
  return { referencePhotoId: w.referencePhotoId, referencePhotoSource: w.referencePhotoSource, referencePhotoSourceUrl: w.referencePhotoSourceUrl };
}

/**
 * « Chercher une image » : Open Food Facts d'abord, puis, s'il ne donne rien, le
 * site officiel du domaine trouvé par Gemini. Le client ne voit que des
 * identifiants de candidates : aucune adresse venue de lui n'est jamais
 * téléchargée.
 */
@Injectable()
export class ImageSearchService {
  private readonly logger = new Logger(ImageSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_CANDIDATE_STORE) private readonly store: CandidateStore,
    private readonly budget: VisionBudgetService,
    @Inject(OFFICIAL_SITE_PROVIDER) private readonly provider: OfficialSiteProvider,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
    @Inject(IMAGE_SEARCH_FETCHER) private readonly fetcher: Fetcher,
  ) {}

  private async findWine(id: string) {
    const wine = await this.prisma.wine.findUnique({ where: { id }, select: WINE_SELECT });
    if (!wine) throw new NotFoundException('Vin introuvable');
    return wine;
  }

  async search(wineId: string): Promise<{ candidates: ImageCandidateView[] }> {
    const wine = await this.findWine(wineId);
    await this.store.cleanup();
    const query = { producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellationRaw };

    let candidates = await this.download(await searchOpenFoodFacts(query, this.fetcher), wine.id);
    if (candidates.length === 0) candidates = await this.download(await this.officialSiteImages(wine), wine.id);

    return {
      candidates: candidates.map((c) => ({ id: c.id, source: c.source, sourceUrl: c.sourceUrl, imageUrl: `/api/image-candidates/${c.id}` })),
    };
  }

  /** Une image à la fois : cinq décodages sharp simultanés pèseraient trop sur la mémoire du serveur domestique. */
  private async download(images: RemoteImage[], wineId: string): Promise<CandidateMeta[]> {
    const kept: CandidateMeta[] = [];
    for (const image of images) {
      const candidate = await this.store.add(image, wineId);
      if (candidate) kept.push(candidate);
    }
    return kept;
  }

  /** Gemini avec la recherche Google, dans la part du plafond réservée aux accords ; sa dépense est comptée. */
  private async officialSiteImages(wine: { id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null }): Promise<RemoteImage[]> {
    try {
      await this.budget.assertUnderShare(PAIRING_BUDGET_SHARE);
    } catch (e) {
      if (e instanceof VisionBudgetExceededError) throw new ServiceUnavailableException(UNAVAILABLE);
      throw e;
    }
    let result;
    try {
      result = await this.provider.findOfficialSite({ producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellationRaw, vintage: wine.vintage });
    } catch (e) {
      this.logger.warn(`Recherche du site officiel impossible pour le vin ${wine.id} : ${(e as Error).message}`);
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    await this.prisma.imageSearchCost.create({ data: { wineId: wine.id, model: result.model, costCents: result.costCents } });
    if (!result.site) return [];
    return readOfficialSiteImages(result.site, wine, this.fetcher);
  }

  async candidateImage(candidateId: string): Promise<Buffer> {
    try {
      return await this.store.read(candidateId);
    } catch (e) {
      if (e instanceof CandidateExpiredError) throw new GoneException(e.message);
      throw e;
    }
  }

  /**
   * La candidate devient une photo REFERENCE (jamais analysée ni à confirmer) et
   * la vignette du vin. La vignette d'avant est mémorisée une seule fois : choisir
   * une autre image du web ne fait pas oublier la photo de l'utilisateur.
   */
  async chooseReference(wineId: string, candidateId: string): Promise<ReferenceImageView> {
    await this.findWine(wineId);
    let meta: CandidateMeta;
    try {
      meta = await this.store.get(candidateId, wineId);
    } catch (e) {
      if (e instanceof CandidateExpiredError) throw new GoneException(e.message);
      throw e;
    }

    const photoId = randomUUID();
    const storagePath = join('normalized', `${photoId}.jpg`);
    try {
      await this.store.take(candidateId, join(this.dir, storagePath), wineId);
    } catch (e) {
      if (e instanceof CandidateExpiredError) throw new GoneException(e.message);
      throw e;
    }

    let replaced: string | null = null;
    let view: ReferenceImageView;
    try {
      view = await this.prisma.$transaction(async (tx) => {
        const wine = await this.lockWine(tx, wineId);
        const current = wine.referencePhotoId
          ? await tx.photo.findUnique({ where: { id: wine.referencePhotoId }, select: { id: true, purpose: true } })
          : null;
        const currentIsReference = current?.purpose === 'REFERENCE';
        await tx.photo.create({
          // Empreinte propre à la photo : une image du web ne doit jamais être prise
          // pour une photo d'entrée qui aurait les mêmes octets (et inversement).
          data: { id: photoId, contentHash: `reference:${photoId}`, storagePath, mimeType: 'image/jpeg', status: 'DONE', purpose: 'REFERENCE' },
        });
        const updated = await tx.wine.update({
          where: { id: wineId },
          data: {
            referencePhotoId: photoId,
            referencePhotoPreviousId: currentIsReference ? wine.referencePhotoPreviousId : wine.referencePhotoId,
            referencePhotoSource: meta.source,
            referencePhotoSourceUrl: meta.sourceUrl,
          },
          select: WINE_SELECT,
        });
        if (currentIsReference) {
          await tx.photo.delete({ where: { id: current.id } });
          replaced = current.id;
        }
        return viewOf(updated);
      });
    } catch (e) {
      await unlinkQuietly(join(this.dir, storagePath));
      throw e;
    }
    if (replaced) await this.removeFiles(replaced);
    return view;
  }

  /**
   * « Revenir à ma photo » : rétablit la vignette d'avant et oublie l'image du web.
   * Sans vignette d'avant, reprend la photo d'entrée la plus récente qui a servi à
   * une entrée de ce vin (s'il y en a une). Sans image du web, ne change rien.
   */
  async revertReference(wineId: string): Promise<ReferenceImageView> {
    await this.findWine(wineId);
    let removed: string | null = null;
    const view = await this.prisma.$transaction(async (tx) => {
      const wine = await this.lockWine(tx, wineId);
      const current = wine.referencePhotoId
        ? await tx.photo.findUnique({ where: { id: wine.referencePhotoId }, select: { id: true, purpose: true } })
        : null;
      if (current?.purpose !== 'REFERENCE') return viewOf(wine);
      const restored =
        wine.referencePhotoPreviousId ??
        (
          await tx.photo.findFirst({
            where: { purpose: 'ENTRY', movements: { some: { wineId } } },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
        )?.id ??
        null;
      const updated = await tx.wine.update({
        where: { id: wineId },
        data: { referencePhotoId: restored, referencePhotoPreviousId: null, referencePhotoSource: null, referencePhotoSourceUrl: null },
        select: WINE_SELECT,
      });
      await tx.photo.delete({ where: { id: current.id } });
      removed = current.id;
      return viewOf(updated);
    });
    if (removed) await this.removeFiles(removed);
    return view;
  }

  /** Verrou de ligne : deux choix simultanés ne mémorisent pas chacun une « vignette d'avant » différente. */
  private async lockWine(tx: Prisma.TransactionClient, wineId: string) {
    await tx.$queryRaw`SELECT id FROM wine WHERE id = ${wineId} FOR UPDATE`;
    const wine = await tx.wine.findUnique({ where: { id: wineId }, select: WINE_SELECT });
    if (!wine) throw new NotFoundException('Vin introuvable');
    return wine;
  }

  private async removeFiles(photoId: string): Promise<void> {
    try {
      await unlinkQuietly(join(this.dir, 'normalized', `${photoId}.jpg`));
      await unlinkQuietly(join(this.dir, 'normalized', `${photoId}.display.jpg`));
    } catch (e) {
      this.logger.warn(`Image du web ${photoId} non effacée du disque : ${(e as Error).message}`);
    }
  }
}
