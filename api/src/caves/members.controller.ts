import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CaveRole, CurrentCave } from './cave-access.decorators';
import { CaveAccessGuard } from './cave-access.guard';
import type { CaveAccess } from './cave-context.service';
import { addMemberSchema, renameCaveSchema } from './dto';
import { MembersService } from './members.service';

/** Cave courante : membres et nom, réservés au propriétaire. */
@Controller('caves/current')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class CurrentCaveController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  @CaveRole('OWNER')
  list(@CurrentCave() cave: CaveAccess) {
    return this.members.list(cave.caveId);
  }

  @Post('members')
  @CaveRole('OWNER')
  add(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    return this.members.add(cave.caveId, parsed.data.email);
  }

  @Delete('members/:id')
  @CaveRole('OWNER')
  @HttpCode(204)
  async remove(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.members.remove(cave.caveId, id);
  }

  @Patch()
  @CaveRole('OWNER')
  rename(@CurrentCave() cave: CaveAccess, @Body() body: unknown) {
    const parsed = renameCaveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    return this.members.rename(cave.caveId, parsed.data.name);
  }
}
