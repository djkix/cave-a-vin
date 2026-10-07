import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { StatsService } from './stats.service';

@Controller('stats')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /** Lisible par un membre, sans les champs de prix (retirés par le service selon le rôle). */
  @Get()
  @CaveRole('VIEWER')
  get(@CurrentCave() cave: CaveAccess) {
    return this.stats.compute(cave.caveId, cave.role);
  }
}
