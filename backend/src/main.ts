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
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import * as bodyParser from 'body-parser';
import { markUnready } from './health/health.controller';
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
  // Security headers on every response. This is a JSON API consumed by the
  // frontend proxy, not a browser-rendered site, so CSP (geared at HTML) is
  // left off and the resource policies that would block the proxy are relaxed;
  // the useful headers here are nosniff, frameguard, HSTS and referrer policy.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Validate and strip every incoming DTO. `whitelist` drops unknown
  // properties, `forbidNonWhitelisted` rejects requests that send them, and
  // `transform` coerces payloads into the DTO classes (so `@Type`/typed params
  // are honoured). This is the single enforcement point the MR-11 DTO sweep
  // relies on; per-route manual validators remain only where a payload shape
  // cannot be expressed as a class (e.g. the batch import alias handling).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  // The browser reaches the API only through the frontend's same-origin
  // proxy, so no other origin has a reason to call it from a page.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS || process.env.APP_URL || 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  // `BetterAuthGuard` takes the pino-backed logger as its first constructor
  // arg (T025). The global instance is constructed outside Nest's DI
  // container, so we pull both the Logger and the Reflector out manually.
  // The per-request `userId` is attached to the request by the guard
  // itself after token verification; `pino-http`'s `customProps` (set in
  // `AppModule.LoggerModule.forRoot`) reads it from there.
  app.useGlobalGuards(new BetterAuthGuard(app.get(PinoNestLogger), app.get(Reflector)));
  // Logs the *cause* chain of thrown errors (Drizzle wraps the real PG
  // error in `cause`, so the default Nest handler only logs the wrapper
  // message — see common/unwrap-cause.filter.ts).
  app.useGlobalFilters(new UnwrapCauseExceptionFilter());
  // Hand off all Nest-internal logging to the pino-backed logger registered
  // in AppModule via LoggerModule.forRoot(...). This includes framework
  // messages (InstanceLoader, RoutesResolver, Mapped {/path, METHOD}).
  app.useLogger(app.get(PinoNestLogger));
  await app.listen(process.env.PORT || 4611);

  app.enableShutdownHooks();

  // An unhandled promise rejection is logged and survived: libraries such as
  // imapflow reject in-flight commands when a socket drops, and one lost
  // connection must not take every job and request down with it (this
  // happened on 2026-06-24). Known socket errors are also handled at source
  // by the 'error' listeners in ImapClientService.
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[backend] unhandledRejection:', reason);
  });
  // An uncaught exception leaves the process in an unknown state. Stop
  // reporting ready, let in-flight work drain briefly, then exit so the
  // supervisor starts a clean process. Jobs are safe to resume: sends and
  // receive actions are recorded in the ledger as they happen.
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[backend] uncaughtException — shutting down:', err);
    markUnready();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref?.();
    app
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
}
bootstrap();
