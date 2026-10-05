import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { safeParseExtraction } from '../vision/extraction-schema';
import { PhotosService } from './photos.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const purposeSchema = z.enum(['ENTRY', 'EXIT']).default('ENTRY');

@Controller('photos')
@UseGuards(AuthenticatedGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  // 30 photos par minute et par IP : large pour une campagne au téléphone (une prise
  // toutes les deux secondes), assez bas pour qu'un flush de file emballé ou un script
  // ne sature ni sharp ni le quota Gemini.
  @Post()
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@UploadedFile() file?: Express.Multer.File, @Body('purpose') rawPurpose?: string) {
    if (!file) throw new BadRequestException('Fichier « file » manquant');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('Format d’image non pris en charge');
    const purpose = purposeSchema.safeParse(rawPurpose ?? undefined);
    if (!purpose.success) throw new BadRequestException('Destination de photo inconnue');
    const { photo, duplicate } = await this.photos.ingest(file.buffer, file.mimetype, purpose.data);
    return { id: photo.id, status: photo.status, duplicate };
  }

  // Déclarées avant `@Get(':id')` : sinon « queue-status », « entry-inbox » et
  // « pending-review » seraient pris pour des identifiants de photo.
  @Get('queue-status')
  queueStatus() {
    return this.photos.queueStatus();
  }

  @Get('entry-inbox')
  entryInbox() {
    return this.photos.entryInbox();
  }

  @Get('pending-review')
  async pendingReview() {
    const photos = await this.photos.listPendingReview();
    return photos.map((p) => ({ ...p, extraction: safeParseExtraction(p.rawExtraction) }));
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  async dismiss(@Param('id') id: string) {
    await this.photos.dismiss(id);
    return { ok: true };
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.photos.findById(id);
  }

  @Get(':id/image')
  async image(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    await this.photos.findById(id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(await this.photos.readNormalized(id));
  }
}
