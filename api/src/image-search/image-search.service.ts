import { GoneException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DISPLAY_FILE_NAMES } from '../photos/display-image';
import { PHOTO_STORAGE_DIR } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { statusFromMessage } from '../queue/transient-failure';
import { GeminiJournal } from '../vision/gemini-journal';
import { GeminiPause, GeminiPausedError } from '../vision/gemini-pause';
import { CaveBudgetShareExceededError, PAIRING_BUDGET_SHARE, VisionBudgetExceededError, VisionBudgetService } from '../queue/vision-budget.service';
import { OFFICIAL_SITE_PROVIDER, OfficialSiteProvider } from '../vision/official-site-provider.interface';
import { CandidateExpiredError, CandidateMeta, CandidateStore } from './candidates';
import { readOfficialSiteImages } from './official-site';
import { searchOpenFoodFacts } from './open-food-facts';
import { Fetcher, RemoteImage } from './types';

export const IMAGE_CANDIDATE_STORE = 'IMAGE_CANDIDATE_STORE';
export const IMAGE_SEARCH_FETCHER = 'IMAGE_SEARCH_FETCHER';

const UNAVAILABLE = 'Recherche d’image indisponible pour le moment';
const CAVE_SHARE_REACHED = 'Part mensuelle de cette cave atteinte — recherche possible le mois prochain';
/** Google refuse l'appel (429) : quota de la clé Gemini épuisé, souvent faute de facturation activée. */
const QUOTA_EXHAUSTED = 'Recherche d’image impossible : quota Gemini épuisé';

/** Délai global d'une recherche : Open Food Facts, Gemini, page du site et téléchargements compris. */
export const SEARCH_DEADLINE_MS = 30_000;

class DeadlineError extends Error {}

/** Dépense comptée pour un appel ancré abandonné au délai : une recherche Google (1,4 ct, arrondie). */
export const ABORTED_CALL_COST_CENTS = 2;
const ABORTED_CALL_MODEL = 'délai dépassé (estimation)';

/**
 * Rejette (DeadlineError) dès que le délai global est écoulé, même si l'opération
 * attendue ignore le signal : la réponse au client ne dépend jamais d'un tiers lent.
 */
function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new DeadlineError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

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
  id: true, caveId: true, producer: true, cuvee: true, appellationRaw: true, vintage: true,
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
 * téléchargée. La recherche entière tient en 30 s : passé ce délai, les images
 * déjà prêtes sont rendues, et sans aucune image prête c'est un 503.
 */
@Injectable()
export class ImageSearchService {
  private readonly logger = new Logger(ImageSearchService.name);
  /** Délai global, modifiable par les tests. */
  deadlineMs = SEARCH_DEADLINE_MS;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_CANDIDATE_STORE) private readonly store: CandidateStore,
    private readonly budget: VisionBudgetService,
    @Inject(OFFICIAL_SITE_PROVIDER) private readonly provider: OfficialSiteProvider,
    @Inject(PHOTO_STORAGE_DIR) private readonly dir: string,
    @Inject(IMAGE_SEARCH_FETCHER) private readonly fetcher: Fetcher,
    private readonly pause: GeminiJournal,
  ) {}

  /**
   * Pause commune lue avant le délai global : une lecture lente ne peut pas
   * faire expirer le délai et compter l'estimation d'un appel abandonné alors
   * qu'aucun appel n'est parti. Base injoignable : pas de pause (le fournisseur
   * revérifie de toute façon avant d'appeler).
   */
  private async pauseBeforeDeadline(): Promise<GeminiPause | null> {
    try {
      return await this.pause.currentPause();
    } catch (e) {
      this.logger.warn(`Pause Gemini illisible avant la recherche d'image : ${(e as Error).message}`);
      return null;
    }
  }

  /** Vin de la cave courante ; celui d'une autre cave est inexistant (404). */
  private async findWine(caveId: string, id: string) {
    const wine = await this.prisma.wine.findFirst({ where: { id, caveId }, select: WINE_SELECT });
    if (!wine) throw new NotFoundException('Vin introuvable');
    return wine;
  }

  /**
   * Chaque recherche laisse une trace : son arrivée, puis son issue (nombre
   * d'images et durée) ou la raison du refus — un « indisponible » n'est jamais
   * muet dans les journaux.
   */
  async search(caveId: string, wineId: string): Promise<{ candidates: ImageCandidateView[] }> {
    const started = Date.now();
    this.logger.log(`Recherche d'image demandée pour le vin ${wineId}`);
    try {
      const result = await this.searchImages(caveId, wineId);
      this.logger.log(`Recherche d'image du vin ${wineId} : ${result.candidates.length} image(s) en ${Date.now() - started} ms`);
      return result;
    } catch (e) {
      this.logger.warn(`Recherche d'image du vin ${wineId} refusée en ${Date.now() - started} ms : ${(e as Error).message}`);
      throw e;
    }
  }

  private async searchImages(caveId: string, wineId: string): Promise<{ candidates: ImageCandidateView[] }> {
    const wine = await this.findWine(caveId, wineId);
    await this.store.cleanup();
    const query = { producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellationRaw, vintage: wine.vintage };
    const pause = await this.pauseBeforeDeadline();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    const signal = controller.signal;
    try {
      const kept: CandidateMeta[] = [];
      await this.download(await this.offImages(query, signal), wine.id, signal, kept);
      if (kept.length === 0 && !signal.aborted) {
        // En pause : Open Food Facts reste proposé, Gemini n'est pas appelé.
        if (pause) throw new ServiceUnavailableException(new GeminiPausedError(pause.until, pause.reason).message);
        await this.download(await this.officialSiteImages(wine, signal), wine.id, signal, kept);
      }
      if (kept.length === 0 && signal.aborted) {
        this.logger.warn(`Recherche d'image du vin ${wine.id} interrompue : délai de ${this.deadlineMs} ms écoulé`);
        throw new ServiceUnavailableException(UNAVAILABLE);
      }
      return {
        candidates: kept.map((c) => ({ id: c.id, source: c.source, sourceUrl: c.sourceUrl, imageUrl: `/api/image-candidates/${c.id}` })),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async offImages(query: Parameters<typeof searchOpenFoodFacts>[0], signal: AbortSignal): Promise<RemoteImage[]> {
    try {
      return await beforeDeadline(searchOpenFoodFacts(query, this.fetcher, signal), signal);
    } catch (e) {
      if (e instanceof DeadlineError) return [];
      throw e;
    }
  }

  /**
   * Une image à la fois : cinq décodages sharp simultanés pèseraient trop sur la
   * mémoire du serveur domestique. Le délai global écoulé, on s'arrête et on garde
   * celles déjà prêtes.
   */
  private async download(images: RemoteImage[], wineId: string, signal: AbortSignal, kept: CandidateMeta[]): Promise<void> {
    for (const image of images) {
      if (signal.aborted) return;
      try {
        const candidate = await beforeDeadline(this.store.add(image, wineId, signal), signal);
        if (candidate) kept.push(candidate);
      } catch (e) {
        if (e instanceof DeadlineError) return;
        throw e;
      }
    }
  }

  /**
   * Gemini avec la recherche Google, dans la part du plafond réservée aux accords
   * et dans la part mensuelle de la cave du vin ; sa dépense est comptée.
   * Gemini en panne ou qui ne répond pas avant le délai global : 503 (on
   * n'arrive ici que sans image d'Open Food Facts).
   */
  private async officialSiteImages(
    wine: { id: string; caveId: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null },
    signal: AbortSignal,
  ): Promise<RemoteImage[]> {
    try {
      await this.budget.assertUnderShare(PAIRING_BUDGET_SHARE);
      await this.budget.assertCaveUnderShare(wine.caveId);
    } catch (e) {
      // Part de la cave atteinte : même 503 que le plafond, avec le motif de la
      // cave (le motif des photos parle de reprise, ici rien ne reprend seul).
      if (e instanceof CaveBudgetShareExceededError) throw new ServiceUnavailableException(CAVE_SHARE_REACHED);
      if (e instanceof VisionBudgetExceededError) {
        this.logger.warn(`Recherche du site officiel refusée pour le vin ${wine.id} : ${e.message}`);
        throw new ServiceUnavailableException(UNAVAILABLE);
      }
      throw e;
    }
    let result;
    try {
      result = await beforeDeadline(
        this.provider.findOfficialSite({ producer: wine.producer, cuvee: wine.cuvee, appellation: wine.appellationRaw, vintage: wine.vintage }, signal),
        signal,
      );
    } catch (e) {
      const reason = e instanceof DeadlineError ? `pas de réponse en ${this.deadlineMs} ms` : (e as Error).message;
      this.logger.warn(`Recherche du site officiel impossible pour le vin ${wine.id} : ${reason}`);
      // Pause commune de Gemini : aucun appel n'est parti, rien n'est compté ;
      // le 503 dit jusqu'à quand (l'écran affiche ce message tel quel).
      if (e instanceof GeminiPausedError) throw new ServiceUnavailableException(e.message);
      if (!(e instanceof DeadlineError) && statusFromMessage((e as Error).message) === 429) {
        throw new ServiceUnavailableException(QUOTA_EXHAUSTED);
      }
      // Abandonné au délai, l'appel a pu être facturé : on compte l'estimation
      // d'une recherche (le plafond ne doit jamais sous-estimer la dépense).
      if (e instanceof DeadlineError) {
        await this.prisma.imageSearchCost.create({
          data: { caveId: wine.caveId, wineId: wine.id, model: ABORTED_CALL_MODEL, costCents: ABORTED_CALL_COST_CENTS },
        });
      }
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    // La dépense est portée par la cave du vin (part de budget par cave).
    await this.prisma.imageSearchCost.create({ data: { caveId: wine.caveId, wineId: wine.id, model: result.model, costCents: result.costCents } });
    if (!result.site) return [];
    try {
      return await beforeDeadline(readOfficialSiteImages(result.site, wine, this.fetcher, signal), signal);
    } catch (e) {
      if (e instanceof DeadlineError) return [];
      throw e;
    }
  }

  /**
   * Image d'une candidate cherchée pour un vin de la cave courante. Une
   * candidate d'un vin d'une autre cave est traitée comme inconnue (410, comme
   * une candidate expirée) : elle n'est jamais servie hors de sa cave.
   */
  async candidateImage(caveId: string, candidateId: string): Promise<Buffer> {
    try {
      const meta = await this.store.get(candidateId);
      const wine = await this.prisma.wine.findFirst({ where: { id: meta.wineId, caveId }, select: { id: true } });
      if (!wine) throw new CandidateExpiredError();
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
  async chooseReference(caveId: string, wineId: string, candidateId: string): Promise<ReferenceImageView> {
    // Vin de la cave courante, et candidate cherchée pour ce vin : donc de cette cave.
    await this.findWine(caveId, wineId);
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
          // L'image choisie appartient à la cave du vin.
          data: { id: photoId, caveId: wine.caveId, contentHash: `reference:${photoId}`, storagePath, mimeType: 'image/jpeg', status: 'DONE', purpose: 'REFERENCE' },
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
  async revertReference(caveId: string, wineId: string): Promise<ReferenceImageView> {
    await this.findWine(caveId, wineId);
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
      for (const name of DISPLAY_FILE_NAMES(photoId)) await unlinkQuietly(join(this.dir, 'normalized', name));
    } catch (e) {
      this.logger.warn(`Image du web ${photoId} non effacée du disque : ${(e as Error).message}`);
    }
  }
}
