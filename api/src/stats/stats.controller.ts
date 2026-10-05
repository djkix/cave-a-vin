import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { StatsService } from './stats.service';

@Controller('stats')
@UseGuards(AuthenticatedGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  get() {
    return this.stats.compute();
  }
}
