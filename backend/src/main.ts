// IMPORTANT: load .env BEFORE any other import that reads process.env.
// `db/index.ts` constructs a `pg.Pool` at module top-level using
// `process.env.DATABASE_URL`. If `.env` hasn't been parsed yet, the pool
// gets `connectionString: undefined` and the first query fails SCRAM
// auth with "client password must be a string". Loading dotenv first
// guarantees every downstream module sees a populated process.env.
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: ['.env', '../.env'] });

import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { BetterAuthGuard } from './auth/better-auth.guard';
import { UnwrapCauseExceptionFilter } from './common/unwrap-cause.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Raw-body middleware for the Stripe webhook MUST be registered before the
  // global bodyParser.json() — Stripe verifies its signature against the
  // unparsed request body. Order matters. (The better-auth handler lives in
  // the Next.js app, not the backend, so no /webhooks/better-auth path is
  // needed here.)
  app.use('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }));
  app.use(bodyParser.json());
  app.enableCors();
  app.useGlobalGuards(new BetterAuthGuard(app.get(Reflector)));
  // Logs the *cause* chain of thrown errors (Drizzle wraps the real PG
  // error in `cause`, so the default Nest handler only logs the wrapper
  // message — see common/unwrap-cause.filter.ts).
  app.useGlobalFilters(new UnwrapCauseExceptionFilter());
  await app.listen(process.env.PORT || 3001);
}
bootstrap();
