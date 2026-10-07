import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { VisionBudgetService } from '../queue/vision-budget.service';
import { AdminService } from './admin.service';
import { updateAdminUserSchema, updateBudgetSchema } from './dto';

@Controller('admin/users')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list() {
    return this.admin.listUsers();
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AppUser) {
    const parsed = updateAdminUserSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.admin.updateUser(id, user, parsed.data);
  }

  @Post(':id/cave')
  createCave(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.createCaveFor(id);
  }
}

@Controller('admin/registrations')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminRegistrationsController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list() {
    return this.admin.listRegistrations();
  }

  @Post(':id/validate')
  validate(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.validateRegistration(id);
  }

  @Post(':id/refuse')
  refuse(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.refuseRegistration(id);
  }
}

/** Part du plafond mensuel Gemini qu'une cave peut dépenser (la cave du premier administrateur en est exemptée). */
@Controller('admin/budget')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminBudgetController {
  constructor(private readonly budget: VisionBudgetService) {}

  @Get()
  get() {
    return this.view();
  }

  @Put()
  async update(@Body() body: unknown) {
    const parsed = updateBudgetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    await this.budget.setCaveShare(parsed.data.caveShare);
    return this.view();
  }

  private async view(): Promise<{ caveShare: number; capCents: number; spentThisMonthCents: number }> {
    const [caveShare, spentThisMonthCents] = await Promise.all([this.budget.caveShare(), this.budget.spentThisMonthCents()]);
    return { caveShare, capCents: this.budget.capCents, spentThisMonthCents };
  }
}
