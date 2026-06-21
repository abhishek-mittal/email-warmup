import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { InboxModule } from './inbox/inbox.module';
import { WarmupModule } from './warmup/warmup.module';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    HealthModule,
    QueueModule,
    AuthModule,
    BillingModule,
    InboxModule,
    WarmupModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
