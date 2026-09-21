import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { GeminiVisionProvider } from './gemini-vision.provider';
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
  ],
  exports: [VISION_PROVIDER],
})
export class VisionModule {}
