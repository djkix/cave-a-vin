import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { ApogeeAdminService } from './apogee-admin.service';
import { guardOverrideSchema, vintageQualitySchema } from './dto';

const issues = (e: { issues: { message: string }[] }) => e.issues.map((i) => i.message).join(' ; ');

const searchQuerySchema = z.object({ q: z.string().trim().max(200).optional() });

/** Règles d'apogée : elles changent toute la cave, d'où la garde administrateur. */
@Controller('admin')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class ApogeeAdminController {
  constructor(private readonly admin: ApogeeAdminService) {}

  @Get('vintages')
  listVintages() {
    return this.admin.listVintages();
  }

  @Put('vintages')
  setVintage(@Body() body: unknown) {
    const parsed = vintageQualitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(issues(parsed.error));
    return this.admin.setVintage(parsed.data);
  }

  @Delete('vintages/:region/:year')
  @HttpCode(204)
  removeVintage(
    @Param('region') region: string,
    @Param('year', new ParseIntPipe({ exceptionFactory: () => new BadRequestException('Année invalide') })) year: number,
  ) {
    return this.admin.removeVintage(region, year);
  }

  @Get('guards')
  searchGuards(@Query() query: unknown) {
    const parsed = searchQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Recherche invalide');
    return this.admin.searchGuards(parsed.data.q ?? '');
  }

  @Put('guards')
  setGuard(@Body() body: unknown) {
    const parsed = guardOverrideSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(issues(parsed.error));
    return this.admin.setGuard(parsed.data);
  }

  @Delete('guards/:id')
  @HttpCode(204)
  removeGuard(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => new BadRequestException('Identifiant d’ajustement invalide') })) id: string,
  ) {
    return this.admin.removeGuard(id);
  }
}
