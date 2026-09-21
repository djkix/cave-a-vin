import {
  BadRequestException, Controller, Get, HttpCode, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { PhotosService } from './photos.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Controller('photos')
@UseGuards(AuthenticatedGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier « file » manquant');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('Format d’image non pris en charge');
    const { photo, duplicate } = await this.photos.ingest(file.buffer, file.mimetype);
    return { id: photo.id, status: photo.status, duplicate };
  }

  @Get('pending-review')
  pendingReview() {
    return this.photos.listPendingReview();
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.photos.findById(id);
  }

  @Get(':id/image')
  async image(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(await this.photos.readNormalized(id));
  }
}
