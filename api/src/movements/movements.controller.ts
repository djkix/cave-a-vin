import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { createMovementSchema } from './dto';
import { MovementResult, MovementsService } from './movements.service';

@Controller('movements')
@UseGuards(AuthenticatedGuard)
export class MovementsController {
  constructor(private readonly movements: MovementsService) {}

  @Post()
  create(@Body() body: unknown) {
    const parsed = createMovementSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.createIn(parsed.data);
  }

  @Post('bulk')
  async bulk(@Body() body: unknown) {
    const parsed = z.array(createMovementSchema).min(1).max(200).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Liste de mouvements invalide');
    const results: Array<
      | { ok: true; idempotencyKey: string; result: MovementResult }
      | { ok: false; idempotencyKey: string; error: string }
    > = [];
    for (const item of parsed.data) {
      try {
        results.push({ ok: true as const, idempotencyKey: item.idempotencyKey, result: await this.movements.createIn(item) });
      } catch (e) {
        results.push({ ok: false as const, idempotencyKey: item.idempotencyKey, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { idempotencyKey?: string }) {
    if (!body?.idempotencyKey) throw new BadRequestException('idempotencyKey requis');
    return this.movements.cancel(id, body.idempotencyKey);
  }

  @Get('recent')
  recent(@Query('limit') limit?: string) {
    return this.movements.recent(Math.min(Number(limit ?? 20) || 20, 100));
  }
}
