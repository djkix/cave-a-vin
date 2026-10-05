import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { ReadingQualityService } from './reading-quality.service';

@Controller('admin/reading-quality')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class ReadingQualityController {
  constructor(private readonly quality: ReadingQualityService) {}

  @Get()
  get() {
    return this.quality.compute();
  }
}
