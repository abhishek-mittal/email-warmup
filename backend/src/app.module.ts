import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { UserThrottlerGuard } from './common/throttler-user.guard';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { InboxModule } from './inbox/inbox.module';
import { WarmupModule } from './warmup/warmup.module';
import { MonitorModule } from './monitor/monitor.module';
import { ScoringModule } from './scoring/scoring.module';
import { PlacementModule } from './placement/placement.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { NotifyModule } from './notify/notify.module';
import { AnalysisModule } from './analysis/analysis.module';
import { PoolInboxModule } from './pool-inbox/pool-inbox.module';
import { PoolInboxActivityModule } from './pool-inbox-activity/pool-inbox-activity.module';
import { ActivityModule } from './activity/activity.module';
import { InboxControlModule } from './inbox-control/inbox-control.module';
import { validate } from './config/env.validation';

import { AccountModule } from './account/account.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Load `backend/.env` automatically. Without this, ConfigModule only
      // reads `process.env` and any secret that isn't already exported into
      // the shell (DATABASE_URL, BETTER_AUTH_SECRET, etc.) ends up
      // undefined — which causes the postgres pool to fail SCRAM auth with
      // "client password must be a string".
      envFilePath: ['.env', '../.env'],
      validate,
    }),
    /**
     * Global structured-logging module. Replaces Nest's built-in Logger
     * with pino + pino-http. In dev (`NODE_ENV !== 'production'`) it
     * pretty-prints colourised, single-line output; in production it
     * emits plain JSON readable by GCP Cloud Logging. The pino `level`
     * is read from `LOG_LEVEL` (defaults to `info`). See
     * docs/05-agent-skills/11-skill-logging.md for the per-service log
     * field reference and the `npm run logs:*` CLI recipes. (T025)
     */
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
            : undefined,
        // Redact sensitive fields from auto-emitted HTTP request logs.
        // App-layer logs (logger.info({...}, '...')) must never include
        // these either — see the skill file's "Never log these fields".
        redact: [
          // Request/response auth material and cookies.
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-internal-secret"]',
          'res.headers["set-cookie"]',
          // Top-level credential fields.
          'req.body.smtpPassword',
          'req.body.imapPassword',
          'req.body.smtpPass',
          'req.body.imapPass',
          'req.body.password',
          'req.body.clientSecret',
          'req.body.refreshToken',
          'req.body.accessToken',
          // OAuth callback params.
          'req.body.code',
          'req.body.state',
          'req.query.code',
          'req.query.state',
          // Nested batch-import credentials (alias + canonical names).
          'req.body.inboxes[*].smtpPassword',
          'req.body.inboxes[*].imapPassword',
          'req.body.inboxes[*].smtpPass',
          'req.body.inboxes[*].imapPass',
          'req.body.inboxes[*].clientSecret',
          'req.body.inboxes[*].refreshToken',
        ],
        // Attach inboxId from the request path/params to every HTTP log line.
        customProps: (req) => ({
          inboxId: (req as any).params?.id ?? (req as any).body?.inboxId,
          userId: (req as any).userId,
        }),
        // Silence the per-request /health log spam — the only way to see
        // the live-backend liveness signal is the bottom of the log file.
        autoLogging: {
          ignore: (req) => req.url === '/health',
        },
      },
    }),
    ScheduleModule.forRoot(),
    // Rate limiting. One global ceiling for ordinary dashboard traffic; the
    // expensive/abusable routes (inbox connect, batch import, placement runs)
    // tighten this with a per-route @Throttle override. A single named
    // throttler is used deliberately — every named throttler in this array is
    // enforced on every route, so a second one here would cap all traffic to
    // the lower limit.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
    }),
    HealthModule,
    QueueModule,
    AuthModule,
    BillingModule,
    InboxModule,
    WarmupModule,
    MonitorModule,
    ScoringModule,
    PlacementModule,
    DiagnosticsModule,
    NotifyModule,
    AnalysisModule,
    PoolInboxModule,
    PoolInboxActivityModule,
    ActivityModule,
    InboxControlModule,
    AccountModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: UserThrottlerGuard }],
})
export class AppModule {}
