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
import { Logger as PinoNestLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { BetterAuthGuard } from './auth/better-auth.guard';
import { UnwrapCauseExceptionFilter } from './common/unwrap-cause.filter';

async function bootstrap() {
  // `bufferLogs: true` makes Nest's built-in logger defer output until
  // we attach our pino-backed logger below. Without this, Nest's noisy
  // "InstanceLoader" / "RoutesResolver" lines print via the default
  // console logger before pino takes over and we'd get interleaved
  // formats in dev.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  // Raw-body middleware for the Stripe webhook MUST be registered before the
  // global bodyParser.json() — Stripe verifies its signature against the
  // unparsed request body. Order matters. (The better-auth handler lives in
  // the Next.js app, not the backend, so no /webhooks/better-auth path is
  // needed here.)
  app.use('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }));
  app.use(bodyParser.json());
  app.enableCors();
  // `BetterAuthGuard` takes the pino-backed logger as its first constructor
  // arg (T025). The global instance is constructed outside Nest's DI
  // container, so we pull both the Logger and the Reflector out manually.
  // The per-request `userId` is attached to the request by the guard
  // itself after token verification; `pino-http`'s `customProps` (set in
  // `AppModule.LoggerModule.forRoot`) reads it from there.
  app.useGlobalGuards(
    new BetterAuthGuard(app.get(PinoNestLogger), app.get(Reflector)),
  );
  // Logs the *cause* chain of thrown errors (Drizzle wraps the real PG
  // error in `cause`, so the default Nest handler only logs the wrapper
  // message — see common/unwrap-cause.filter.ts).
  app.useGlobalFilters(new UnwrapCauseExceptionFilter());
  // Hand off all Nest-internal logging to the pino-backed logger registered
  // in AppModule via LoggerModule.forRoot(...). This includes framework
  // messages (InstanceLoader, RoutesResolver, Mapped {/path, METHOD}).
  app.useLogger(app.get(PinoNestLogger));
  await app.listen(process.env.PORT || 3001);
}
bootstrap();
