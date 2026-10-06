import { BadRequestException, Body, Controller, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { producerDescriptionSchema } from './producer-description.dto';
import { ProducersService } from './producers.service';

/** `:key` = clé normalisée du domaine (normalizeLabel), encodée dans l'URL. */
@Controller('producers')
@UseGuards(AuthenticatedGuard)
export class ProducersController {
  constructor(private readonly producers: ProducersService) {}

  @Put(':key/description')
  setDescription(@Param('key') key: string, @Body() body: unknown, @CurrentUser() user: AppUser) {
    const parsed = producerDescriptionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' ; '));
    return this.producers.setDescription(key, parsed.data.description, user.id);
  }

  @Post(':key/regenerate')
  @HttpCode(202)
  regenerate(@Param('key') key: string) {
    return this.producers.regenerate(key);
  }
}
