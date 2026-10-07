import { BadRequestException, Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { createQuoteSchema } from './quote';
import { QuotesService } from './quotes.service';

/** Cote iDealwine saisie à la main : un prix, réservé au propriétaire. */
@Controller('wines/:id/quotes')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  @CaveRole('OWNER')
  create(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AppUser) {
    const parsed = createQuoteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.quotes.create(cave.caveId, id, parsed.data, user.id);
  }
}
