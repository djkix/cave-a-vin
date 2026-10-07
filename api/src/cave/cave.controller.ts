import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { z } from 'zod';
import { manualApogeeSchema } from '../apogee/dto';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { inventorySchema } from '../movements/dto';
import { MovementsService } from '../movements/movements.service';
import { CaveService } from './cave.service';
import { ratingSchema } from './rating.dto';

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']).optional(),
  includeEmpty: z.enum(['true', 'false']).optional(),
  drinkSoon: z.enum(['true', 'false']).optional(),
  noApogee: z.enum(['true', 'false']).optional(),
  dish: z.string().trim().max(100).optional(),
});

/** Lecture (liste, filtres, recherche par plat, fiche) : VIEWER ; toute écriture : OWNER. */
@Controller()
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class CaveController {
  constructor(
    private readonly cave: CaveService,
    private readonly movements: MovementsService,
  ) {}

  @Get('cave')
  @CaveRole('VIEWER')
  list(@CurrentCave() cave: CaveAccess, @Query() query: unknown) {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Filtre de cave invalide');
    const { q, color, includeEmpty, drinkSoon, noApogee, dish } = parsed.data;
    if (drinkSoon === 'true' && noApogee === 'true') {
      throw new BadRequestException('Choisis « à boire en priorité » ou « sans apogée », pas les deux');
    }
    return this.cave.list(cave.caveId, { q, color, includeEmpty: includeEmpty === 'true', drinkSoon: drinkSoon === 'true', noApogee: noApogee === 'true', dish: dish || undefined });
  }

  @Get('wines/:id')
  @CaveRole('VIEWER')
  detail(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.cave.detail(cave.caveId, id);
  }

  @Post('wines/:id/inventory')
  @CaveRole('OWNER')
  inventory(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = inventorySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.adjustTo(cave.caveId, id, parsed.data);
  }

  // Étape de la sortie (photo envoyée par le propriétaire) : réservée au propriétaire.
  @Get('photos/:id/exit-candidates')
  @CaveRole('OWNER')
  exitCandidates(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.cave.exitCandidates(cave.caveId, id);
  }

  @Put('wines/:id/apogee')
  @CaveRole('OWNER')
  setApogee(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = manualApogeeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.cave.setManualApogee(cave.caveId, id, parsed.data);
  }

  @Delete('wines/:id/apogee')
  @CaveRole('OWNER')
  clearApogee(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.cave.clearManualApogee(cave.caveId, id);
  }

  @Put('wines/:id/rating')
  @CaveRole('OWNER')
  setRating(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AppUser) {
    const parsed = ratingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.cave.setRating(cave.caveId, id, parsed.data.rating, user.id);
  }

  @Delete('wines/:id/rating')
  @CaveRole('OWNER')
  clearRating(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.cave.clearRating(cave.caveId, id);
  }
}
