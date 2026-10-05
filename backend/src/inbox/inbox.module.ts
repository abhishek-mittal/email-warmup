import { Module } from '@nestjs/common';
import { InboxController, AuthCallbackController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { ImapClientService } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { MailCredentialService } from './oauth/mail-credential.service';
import { TokenRefreshProcessor } from './oauth/token-refresh.processor';
import { MailboxLinkService } from './oauth/mailbox-link.service';
import { DnsService } from '../monitor/dns.service';
import { PairingService } from '../warmup/pairing.service';
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
    MailCredentialService,
    TokenRefreshProcessor,
    MailboxLinkService,
    // Stateless; provided here as well as in MonitorModule, which cannot be
    // imported from this module without a cycle.
    DnsService,
    // Stateless; provided here too (importing WarmupModule would cycle: warmup
    // imports inbox). Used only for the read-only warmupEligibility check.
    PairingService,
  ],
  exports: [
    InboxService,
    GoogleOAuthService,
    MicrosoftOAuthService,
    ImapClientService,
    SmtpClientService,
    MailCredentialService,
  ],
})
export class InboxModule {}
