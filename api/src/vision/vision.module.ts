import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { GeminiVisionProvider } from './gemini-vision.provider';
import { PAIRING_PROVIDER } from './pairing-provider.interface';
import { PRODUCER_PROVIDER } from './producer-provider.interface';
import { VISION_PROVIDER } from './vision-provider.interface';

@Module({
  providers: [
    {
      provide: VISION_PROVIDER,
      useFactory: () => {
        const env = loadEnv();
        return GeminiVisionProvider.fromApiKey(env.GEMINI_API_KEY, env.GEMINI_MODEL);
      },
    },
    { provide: PAIRING_PROVIDER, useExisting: VISION_PROVIDER },
    { provide: PRODUCER_PROVIDER, useExisting: VISION_PROVIDER },
  ],
  exports: [VISION_PROVIDER, PAIRING_PROVIDER, PRODUCER_PROVIDER],
})
export class VisionModule {}
