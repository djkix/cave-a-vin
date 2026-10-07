import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { ImageSearchService } from './image-search.service';

const chooseSchema = z.object({ candidateId: z.string().uuid() });

@Controller()
@UseGuards(AuthenticatedGuard)
export class ImageSearchController {
  constructor(private readonly images: ImageSearchService) {}

  // Chaque recherche télécharge jusqu'à 5 images et peut appeler Gemini : 10 par
  // minute suffisent largement à un usage manuel.
  @Post('wines/:id/image-search')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  search(@Param('id', ParseUUIDPipe) id: string) {
    return this.images.search(id);
  }

  @Get('image-candidates/:id')
  async candidate(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const image = await this.images.candidateImage(id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(image);
  }

  @Post('wines/:id/reference-image')
  @HttpCode(200)
  choose(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = chooseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Proposition d’image invalide');
    return this.images.chooseReference(id, parsed.data.candidateId);
  }

  @Delete('wines/:id/reference-image')
  revert(@Param('id', ParseUUIDPipe) id: string) {
    return this.images.revertReference(id);
  }
}
