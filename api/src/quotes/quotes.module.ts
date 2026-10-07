import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CavesModule } from '../caves/caves.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({ imports: [AuthModule, CavesModule], controllers: [QuotesController], providers: [QuotesService] })
export class QuotesModule {}
