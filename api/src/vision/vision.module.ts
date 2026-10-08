import { Logger, Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiJournal } from './gemini-journal';
import { GeminiVisionProvider } from './gemini-vision.provider';
import { OFFICIAL_SITE_PROVIDER } from './official-site-provider.interface';
import { PAIRING_PROVIDER } from './pairing-provider.interface';
import { PRODUCER_PROVIDER } from './producer-provider.interface';
import { VISION_PROVIDER } from './vision-provider.interface';

@Module({
  providers: [
    // Journal des appels et pause commune, partagés par l'api et le worker (même base).
    { provide: GeminiJournal, useFactory: (prisma: PrismaService) => new GeminiJournal(prisma, new Logger('GeminiJournal')), inject: [PrismaService] },
    {
      provide: VISION_PROVIDER,
      useFactory: (journal: GeminiJournal) => {
        const env = loadEnv();
        return GeminiVisionProvider.fromApiKey(env.GEMINI_API_KEY, env.GEMINI_MODEL, journal);
      },
      inject: [GeminiJournal],
    },
    { provide: PAIRING_PROVIDER, useExisting: VISION_PROVIDER },
    { provide: PRODUCER_PROVIDER, useExisting: VISION_PROVIDER },
    { provide: OFFICIAL_SITE_PROVIDER, useExisting: VISION_PROVIDER },
  ],
  exports: [GeminiJournal, VISION_PROVIDER, PAIRING_PROVIDER, PRODUCER_PROVIDER, OFFICIAL_SITE_PROVIDER],
})
export class VisionModule {}
