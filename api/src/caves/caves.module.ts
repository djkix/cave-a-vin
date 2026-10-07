import { Module } from '@nestjs/common';
import { CaveContextService } from './cave-context.service';
import { CavesService } from './caves.service';

@Module({ providers: [CaveContextService, CavesService], exports: [CaveContextService, CavesService] })
export class CavesModule {}
