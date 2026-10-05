import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { AppUser, WineColor } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExportService } from './export.service';

const querySchema = z.object({
  color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT'], { errorMap: () => ({ message: 'Couleur inconnue' }) }).optional(),
  region: z.string({ errorMap: () => ({ message: 'Région invalide' }) }).trim().max(100, 'Région invalide').optional(),
  drinkSoon: z.enum(['true', 'false'], { errorMap: () => ({ message: 'Filtre d’export invalide' }) }).optional(),
});

@Controller('export.xlsx')
@UseGuards(AuthenticatedGuard)
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @Get()
  async download(@Query() query: unknown, @CurrentUser() user: AppUser, @Res() res: Response) {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const { color, region, drinkSoon } = parsed.data;
    const filter = { color: color as WineColor | undefined, region: region || undefined, ...(drinkSoon === 'true' ? { drinkSoon: true } : {}) };
    const { buffer } = await this.exporter.buildWorkbook(filter, user.id);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cave-${date}.xlsx"`);
    res.send(buffer);
  }
}
