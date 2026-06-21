import { Module } from '@nestjs/common';
import { InboxController, AuthCallbackController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { ImapClientService } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { BillingModule } from '../billing/billing.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [BillingModule, QueueModule],
  controllers: [InboxController, AuthCallbackController],
  providers: [
    InboxService,
    GoogleOAuthService,
    MicrosoftOAuthService,
    ImapClientService,
    SmtpClientService,
  ],
  exports: [
    InboxService,
    GoogleOAuthService,
    MicrosoftOAuthService,
    ImapClientService,
    SmtpClientService,
  ],
})
export class InboxModule {}
