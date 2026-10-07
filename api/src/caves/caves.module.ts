import { Module } from '@nestjs/common';
import { CaveContextService } from './cave-context.service';
import { CavesService } from './caves.service';
import { MembersService } from './members.service';
import { CurrentCaveController } from './members.controller';

@Module({
  controllers: [CurrentCaveController],
  providers: [CaveContextService, CavesService, MembersService],
  exports: [CaveContextService, CavesService],
})
export class CavesModule {}
