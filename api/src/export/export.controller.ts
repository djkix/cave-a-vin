import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { AppUser, WineColor } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExportService } from './export.service';

const COLORS = new Set<string>(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']);

@Controller('export.xlsx')
@UseGuards(AuthenticatedGuard)
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @Get()
  async download(@Query('color') color: string | undefined, @Query('region') region: string | undefined, @CurrentUser() user: AppUser, @Res() res: Response) {
    if (color && !COLORS.has(color)) throw new BadRequestException('Couleur inconnue');
    const { buffer } = await this.exporter.buildWorkbook({ color: color as WineColor | undefined, region: region || undefined }, user.id);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cave-${date}.xlsx"`);
    res.send(buffer);
  }
}
