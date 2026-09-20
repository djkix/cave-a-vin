import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:3000/api/auth/google/callback'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash'),
  GEMINI_MONTHLY_CAP_CENTS: z.coerce.number().int().default(500),
  PHOTO_STORAGE_DIR: z.string().default('./data/photos'),
  BREAK_GLASS_EMAIL: z.string().email().optional(),
  BREAK_GLASS_PASSWORD: z.string().min(12).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
