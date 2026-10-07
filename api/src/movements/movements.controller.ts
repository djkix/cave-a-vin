import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { cancelMovementSchema, createMovementSchema, createOutSchema } from './dto';
import { MovementResult, MovementsService } from './movements.service';

/** Entrées, sorties, annulations et journal : propriétaire seulement. */
@Controller('movements')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class MovementsController {
  constructor(private readonly movements: MovementsService) {}

  @Post()
  @CaveRole('OWNER')
  create(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    const parsed = createMovementSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.createIn(cave.caveId, parsed.data);
  }

  @Post('bulk')
  @CaveRole('OWNER')
  async bulk(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    const parsed = z.array(createMovementSchema).min(1).max(200).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Liste de mouvements invalide');
    const results: Array<
      | { ok: true; idempotencyKey: string; result: MovementResult }
      | { ok: false; idempotencyKey: string; error: string }
    > = [];
    for (const item of parsed.data) {
      try {
        results.push({ ok: true as const, idempotencyKey: item.idempotencyKey, result: await this.movements.createIn(cave.caveId, item) });
      } catch (e) {
        results.push({ ok: false as const, idempotencyKey: item.idempotencyKey, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  @Post('out')
  @CaveRole('OWNER')
  createOut(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    const parsed = createOutSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.createOut(cave.caveId, parsed.data);
  }

  @Post(':id/cancel')
  @CaveRole('OWNER')
  cancel(@CurrentCave() cave: CaveAccess, @Param('id') id: string, @Body() body: unknown) {
    const parsed = cancelMovementSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.cancel(cave.caveId, id, parsed.data.idempotencyKey);
  }

  @Get('recent')
  @CaveRole('OWNER')
  recent(@CurrentCave() cave: CaveAccess, @Query('limit') limit?: string) {
    return this.movements.recent(cave.caveId, Math.min(Math.max(Number(limit ?? 20) || 20, 1), 100));
  }
}
