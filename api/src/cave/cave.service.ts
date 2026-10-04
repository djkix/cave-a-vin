import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseExtraction } from '../vision/extraction-schema';
import { ExitCandidate, ExitOutcome, ExitRead, rankExitCandidates } from '../wines/exit-ranking';
import { CaveFilter, CaveRow, filterCave } from './cave-filter';

export type ExitCandidatesResponse =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'FAILED'; errorMessage: string | null }
  | { status: 'DONE'; outcome: ExitOutcome; read: ExitRead; candidates: ExitCandidate[] };

@Injectable()
export class CaveService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tous les vins avec leur stock. Lu en une requête puis filtré en mémoire : la
   * cave compte quelques centaines de références, et le filtre se teste ainsi
   * sans base.
   */
  allWithStock(): Promise<CaveRow[]> {
    return this.prisma.$queryRaw<CaveRow[]>`
      SELECT w.id, w.producer, w.cuvee, w.appellation_raw AS "appellationRaw", w.vintage,
             w.color::TEXT AS color, w.format_cl AS "formatCl", w.reference_photo_id AS "referencePhotoId",
             COALESCE(s.quantity, 0)::INTEGER AS quantity
      FROM wine w LEFT JOIN stock_courant s ON s.wine_id = w.id
      ORDER BY w.producer ASC, w.vintage ASC NULLS FIRST`;
  }

  async list(filter: CaveFilter): Promise<CaveRow[]> {
    return filterCave(await this.allWithStock(), filter);
  }

  async detail(id: string) {
    const wine = (await this.allWithStock()).find((r) => r.id === id);
    if (!wine) throw new NotFoundException('Vin introuvable');
    const movements = await this.prisma.movement.findMany({
      where: { wineId: id },
      orderBy: { occurredAt: 'desc' },
      take: 10,
      select: { id: true, delta: true, type: true, occurredAt: true, note: true, reversesId: true },
    });
    return { wine, movements };
  }

  async exitCandidates(photoId: string): Promise<ExitCandidatesResponse> {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    if (photo.status === 'PENDING' || photo.status === 'PROCESSING') return { status: photo.status };
    if (photo.status === 'FAILED') return { status: 'FAILED', errorMessage: photo.errorMessage ?? null };

    let read: ExitRead;
    try {
      const e = parseExtraction(photo.rawExtraction);
      read = { producer: e.producer.value, cuvee: e.cuvee.value, appellation: e.appellation.value, vintage: e.vintage.value };
    } catch {
      // Un prix faux est pire qu'un prix absent ; une sortie fausse aussi : une
      // lecture inexploitable renvoie vers la liste, jamais vers un vin deviné.
      return { status: 'FAILED', errorMessage: 'Lecture de l’étiquette inexploitable' };
    }
    const inStock = (await this.allWithStock())
      .filter((r) => r.quantity > 0)
      .map(({ quantity, referencePhotoId, ...wine }) => ({ wine, quantity, referencePhotoId }));
    return { status: 'DONE', read, ...rankExitCandidates(read, inStock) };
  }
}
