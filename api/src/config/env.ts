import { z } from 'zod';

// `docker compose` hands the whole `.env` to the api and the worker, and `.env.example`
// ships the optional secrets as empty strings. An empty string is "not set", not an
// invalid value: without this the schema would reject it and the container would
// crash-loop on boot.
const emptyToUndefined = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s);

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
  BREAK_GLASS_EMAIL: emptyToUndefined(z.string().email().optional()),
  BREAK_GLASS_PASSWORD: emptyToUndefined(z.string().min(12).optional()),
  // Inscription libre : n'importe quel compte Google obtient un accès immédiat.
  // C'est la seule façon de désigner un administrateur, sinon personne ne
  // pourrait administrer les comptes. Adresses séparées par des virgules.
  ADMIN_EMAILS: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return schema.parse(source);
}

let cached: Env | undefined;

export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
