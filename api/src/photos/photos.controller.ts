import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AppUser } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import { CaveAccess, CaveContextService } from '../caves/cave-context.service';
import { safeParseExtraction } from '../vision/extraction-schema';
import { PhotosService } from './photos.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const purposeSchema = z.enum(['ENTRY', 'EXIT']).default('ENTRY');

/**
 * Envoi, « À confirmer », écarter, file d'attente et lecture d'une photo :
 * propriétaire, dans la cave courante (une photo d'une autre cave est
 * introuvable). L'image seule est servie pour toute cave du compte, propriétaire
 * ou membre, même hors de la cave courante : les vignettes d'une cave lisible
 * restent affichées après un changement de cave.
 */
@Controller('photos')
@UseGuards(AuthenticatedGuard)
export class PhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly caves: CaveContextService,
  ) {}

  // 30 photos par minute et par IP : large pour une campagne au téléphone (une prise
  // toutes les deux secondes), assez bas pour qu'un flush de file emballé ou un script
  // ne sature ni sharp ni le quota Gemini.
  @Post()
  @HttpCode(202)
  @UseGuards(ThrottlerGuard, CaveAccessGuard)
  @CaveRole('OWNER')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@CurrentCave() cave: CaveAccess, @UploadedFile() file?: Express.Multer.File, @Body('purpose') rawPurpose?: string) {
    if (!file) throw new BadRequestException('Fichier « file » manquant');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('Format d’image non pris en charge');
    const purpose = purposeSchema.safeParse(rawPurpose ?? undefined);
    if (!purpose.success) throw new BadRequestException('Destination de photo inconnue');
    const { photo, duplicate } = await this.photos.ingest(cave.caveId, file.buffer, file.mimetype, purpose.data);
    return { id: photo.id, status: photo.status, duplicate };
  }

  // Déclarées avant `@Get(':id')` : sinon « queue-status », « entry-inbox » et
  // « pending-review » seraient pris pour des identifiants de photo.
  @Get('queue-status')
  @UseGuards(CaveAccessGuard)
  @CaveRole('OWNER')
  queueStatus(@CurrentCave() cave: CaveAccess) {
    return this.photos.queueStatus(cave.caveId);
  }

  @Get('entry-inbox')
  @UseGuards(CaveAccessGuard)
  @CaveRole('OWNER')
  entryInbox(@CurrentCave() cave: CaveAccess) {
    return this.photos.entryInbox(cave.caveId);
  }

  @Get('pending-review')
  @UseGuards(CaveAccessGuard)
  @CaveRole('OWNER')
  async pendingReview(@CurrentCave() cave: CaveAccess) {
    const photos = await this.photos.listPendingReview(cave.caveId);
    return photos.map((p) => ({ ...p, extraction: safeParseExtraction(p.rawExtraction) }));
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @UseGuards(CaveAccessGuard)
  @CaveRole('OWNER')
  async dismiss(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    await this.photos.dismiss(cave.caveId, id);
    return { ok: true };
  }

  // Ligne complète (extraction brute comprise) : seul l'écran de confirmation
  // d'entrée la lit, il est réservé au propriétaire.
  @Get(':id')
  @UseGuards(CaveAccessGuard)
  @CaveRole('OWNER')
  one(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.photos.findInCave(cave.caveId, id);
  }

  /**
   * Sans paramètre : l'image d'origine. `?variant=display` : la version
   * d'affichage (recadrée, retouchée). Une photo pas encore lue rend son image
   * d'origine sous cette même adresse : le navigateur ne doit pas la garder, sa
   * version d'affichage viendra après la lecture.
   */
  @Get(':id/image')
  async image(
    @CurrentUser() user: AppUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('variant') variant: string | undefined,
    @Res() res: Response,
  ) {
    if (variant !== undefined && variant !== 'display') throw new BadRequestException("Variante d'image inconnue");
    const photo = await this.photos.findById(id);
    // Pas de garde de cave : toute cave du compte, quel que soit son rôle. Sans
    // accès, la photo est inexistante pour lui.
    if (!(await this.caves.findAccess(user.id, photo.caveId))) throw new NotFoundException('Photo introuvable');
    const settled = photo.status === 'DONE' || photo.status === 'FAILED';
    const image = variant === 'display' ? await this.photos.readDisplay(id) : await this.photos.readNormalized(id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', variant === 'display' && !settled ? 'no-cache' : 'private, max-age=86400');
    res.send(image);
  }
}
