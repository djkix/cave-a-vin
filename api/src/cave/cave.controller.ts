import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { manualApogeeSchema } from '../apogee/dto';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { inventorySchema } from '../movements/dto';
import { MovementsService } from '../movements/movements.service';
import { CaveService } from './cave.service';

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']).optional(),
  includeEmpty: z.enum(['true', 'false']).optional(),
});

@Controller()
@UseGuards(AuthenticatedGuard)
export class CaveController {
  constructor(
    private readonly cave: CaveService,
    private readonly movements: MovementsService,
  ) {}

  @Get('cave')
  list(@Query() query: unknown) {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Filtre de cave invalide');
    return this.cave.list({ q: parsed.data.q, color: parsed.data.color, includeEmpty: parsed.data.includeEmpty === 'true' });
  }

  @Get('wines/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.detail(id);
  }

  @Post('wines/:id/inventory')
  inventory(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = inventorySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.movements.adjustTo(id, parsed.data);
  }

  @Get('photos/:id/exit-candidates')
  exitCandidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.exitCandidates(id);
  }

  @Put('wines/:id/apogee')
  setApogee(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = manualApogeeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.cave.setManualApogee(id, parsed.data);
  }

  @Delete('wines/:id/apogee')
  clearApogee(@Param('id', ParseUUIDPipe) id: string) {
    return this.cave.clearManualApogee(id);
  }
}
