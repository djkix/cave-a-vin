import { Module } from '@nestjs/common';
import { AppellationsModule } from '../appellations/appellations.module';
import { WineMatchingService } from './wine-matching.service';

@Module({ imports: [AppellationsModule], providers: [WineMatchingService], exports: [WineMatchingService] })
export class WinesModule {}
