import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { TrialService } from './trial.service';

@Module({
  imports: [QueueModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, TrialService],
  exports: [BillingService],
})
export class BillingModule {}
