import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { PairingService } from './pairing.service';

@Controller('wines')
@UseGuards(AuthenticatedGuard)
export class PairingController {
  constructor(private readonly pairings: PairingService) {}

  @Post(':id/pairing/regenerate')
  @HttpCode(202)
  regenerate(@Param('id', ParseUUIDPipe) id: string) {
    return this.pairings.regenerate(id);
  }
}
