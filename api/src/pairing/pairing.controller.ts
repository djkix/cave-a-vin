import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { PairingService } from './pairing.service';

/** Régénérer les accords : propriétaire, vin de la cave courante. */
@Controller('wines')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class PairingController {
  constructor(private readonly pairings: PairingService) {}

  @Post(':id/pairing/regenerate')
  @HttpCode(202)
  @CaveRole('OWNER')
  regenerate(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.pairings.regenerate(cave.caveId, id);
  }
}
