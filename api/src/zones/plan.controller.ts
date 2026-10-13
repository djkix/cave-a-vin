import {
  Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Put, Res, UploadedFile, UseFilters, UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AppUser } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { PlanService } from './plan.service';
import { PLAN_NOT_FOUND } from './zone';
import { checkImage, MAX_PHOTO_BYTES, PhotoTooLargeFilter } from './zones.controller';

/** Plan de la cave courante : lu par un membre, envoyé ou retiré par le propriétaire (« Ma cave »). */
@Controller('caves/current/plan')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class CavePlanController {
  constructor(private readonly plans: PlanService) {}

  @Get()
  @CaveRole('VIEWER')
  read(@CurrentCave() cave: CaveAccess) {
    return this.plans.read(cave.caveId);
  }

  // Même plafond et même limite que la photo d'une zone.
  @Put()
  @CaveRole('OWNER')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseFilters(PhotoTooLargeFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  setPlan(@CurrentCave() cave: CaveAccess, @UploadedFile() file?: Express.Multer.File) {
    return this.plans.set(cave.caveId, checkImage(file));
  }

  /** 204 ; les repères des zones sont gardés. */
  @Delete()
  @CaveRole('OWNER')
  @HttpCode(204)
  async remove(@CurrentCave() cave: CaveAccess) {
    await this.plans.remove(cave.caveId);
  }
}

/** Image du plan : servie pour toute cave du compte, propriétaire ou membre, même hors de la cave courante. */
@Controller('caves/plans')
@UseGuards(AuthenticatedGuard)
export class CavePlanImageController {
  constructor(private readonly plans: PlanService) {}

  @Get(':caveId/image')
  async image(
    @CurrentUser() user: AppUser,
    @Param('caveId', new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException(PLAN_NOT_FOUND) })) caveId: string,
    @Res() res: Response,
  ) {
    const image = await this.plans.image(user.id, caveId);
    res.setHeader('Content-Type', 'image/jpeg');
    // Le plan peut être remplacé sous la même adresse : revalidé à chaque affichage (ETag).
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(image);
  }
}

