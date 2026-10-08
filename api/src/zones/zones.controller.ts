import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppUser } from '@prisma/client';
import { Response } from 'express';
import { ZodSchema } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { createZoneSchema, updateZoneSchema, ZONE_NOT_FOUND, zoneOrderSchema } from './zone';
import { ZonesService } from './zones.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

function parse<T>(schema: ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
  return parsed.data;
}

/** Une zone se désigne par un UUID : tout autre identifiant est « introuvable », comme une zone d'une autre cave. */
const zoneId = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException(ZONE_NOT_FOUND) });

/**
 * Zones de la cave courante : lisibles par un membre, modifiées par le
 * propriétaire seulement (« Ma cave »).
 */
@Controller('caves/current/zones')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class CurrentCaveZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  @CaveRole('VIEWER')
  list(@CurrentCave() cave: CaveAccess) {
    return this.zones.list(cave.caveId);
  }

  @Post()
  @CaveRole('OWNER')
  create(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    return this.zones.create(cave.caveId, parse(createZoneSchema, body));
  }

  // Déclarée avant `:id` : « order » n'est pas un identifiant de zone.
  @Post('order')
  @CaveRole('OWNER')
  @HttpCode(200)
  reorder(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    return this.zones.reorder(cave.caveId, parse(zoneOrderSchema, body).ids);
  }

  @Patch(':id')
  @CaveRole('OWNER')
  update(@CurrentCave() cave: CaveAccess, @Param('id', zoneId) id: string, @Body() body: unknown) {
    return this.zones.update(cave.caveId, id, parse(updateZoneSchema, body));
  }

  @Delete(':id')
  @CaveRole('OWNER')
  @HttpCode(204)
  async remove(@CurrentCave() cave: CaveAccess, @Param('id', zoneId) id: string): Promise<void> {
    await this.zones.remove(cave.caveId, id);
  }

  @Put(':id/photo')
  @CaveRole('OWNER')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  setPhoto(@CurrentCave() cave: CaveAccess, @Param('id', zoneId) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier « file » manquant');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('Format d’image non pris en charge');
    return this.zones.setPhoto(cave.caveId, id, file.buffer);
  }

  @Delete(':id/photo')
  @CaveRole('OWNER')
  removePhoto(@CurrentCave() cave: CaveAccess, @Param('id', zoneId) id: string) {
    return this.zones.removePhoto(cave.caveId, id);
  }
}

/**
 * Photo d'une zone : servie pour toute cave du compte, propriétaire ou membre,
 * même hors de la cave courante (comme l'image d'une photo d'étiquette).
 */
@Controller('caves/zones')
@UseGuards(AuthenticatedGuard)
export class ZonePhotoController {
  constructor(private readonly zones: ZonesService) {}

  @Get(':id/photo')
  async photo(@CurrentUser() user: AppUser, @Param('id', zoneId) id: string, @Res() res: Response) {
    const image = await this.zones.readPhoto(user.id, id);
    res.setHeader('Content-Type', 'image/jpeg');
    // La photo peut être remplacée sous la même adresse : revalidée à chaque affichage (ETag).
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(image);
  }
}
