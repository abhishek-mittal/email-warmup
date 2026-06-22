import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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
import { validate } from './config/env.validation';

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
    ScheduleModule.forRoot(),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
