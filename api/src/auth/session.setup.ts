import { INestApplication, Logger } from '@nestjs/common';
import RedisStore from 'connect-redis';
import session from 'express-session';
import Redis from 'ioredis';
import passport from 'passport';
import { loadEnv } from '../config/env';

const logger = new Logger('Session');

export function setupSession(app: INestApplication) {
  const env = loadEnv();
  const client = new Redis(env.REDIS_URL);
  client.on('error', (err) => logger.error(`Redis (sessions) : ${err.message}`, err.stack));
  app.use(
    session({
      store: new RedisStore({ client, prefix: 'cave:sess:' }),
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      name: 'cave.sid',
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30,
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());
}
