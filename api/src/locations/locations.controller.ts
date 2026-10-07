import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { LocationsService } from './locations.service';

/** Emplacements de la cave (suggestions de saisie, filtre) : lisibles par un membre. */
@Controller('locations')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @CaveRole('VIEWER')
  list(@CurrentCave() cave: CaveAccess) {
    return this.locations.list(cave.caveId);
  }
}
