import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { inboxes } from '../../db/schema';
import { QueueService } from '../../queue/queue.service';
import { isOAuthProvider } from '../provider-config';
import { MailCredentialService } from './mail-credential.service';
import { CredentialRevokedError } from './oauth-errors';

export interface TokenRefreshJobData {
  inboxId: string;
}

/** Access tokens last about an hour; refresh comfortably inside that. */
export const TOKEN_REFRESH_INTERVAL_MS = 45 * 60_000;

/**
 * Keeps OAuth inboxes' access tokens warm (MR-08). SMTP/IMAP also refresh on
 * demand through MailCredentialService, so this worker is not load-bearing for
 * correctness — its job is to notice a revoked grant within the hour rather
 * than at the next send, and to keep the stored token fresh for idle inboxes.
 *
 * Each run re-arms itself; the chain ends when the inbox is gone, is not an
 * OAuth inbox, or its grant was revoked.
 */
@Injectable()
@Processor('token-refresh')
export class TokenRefreshProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(TokenRefreshProcessor.name)
    private readonly logger: PinoLogger,
    private readonly credentials: MailCredentialService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  async process(job: Job<TokenRefreshJobData>): Promise<void> {
    const { inboxId } = job.data;
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || !isOAuthProvider(inbox.provider) || inbox.status === 'disconnected') {
      this.logger.info({ inboxId }, 'token-refresh: inbox gone or not OAuth — chain ended');
      return;
    }

    try {
      await this.credentials.getInboxAccessToken(inboxId, { force: true });
    } catch (err) {
      if (err instanceof CredentialRevokedError) {
        // Inbox already taken out of warmup by the credential service.
        this.logger.warn({ inboxId }, 'token-refresh: grant revoked — chain ended');
        return;
      }
      // Temporary provider/network failure: keep the chain alive and try again
      // on the normal cadence. On-demand refresh covers sends in the meantime.
      this.logger.warn(
        { inboxId, err: (err as Error)?.message },
        'token-refresh: temporary failure, will retry next cycle',
      );
    }

    await this.queueService.addTokenRefresh({ inboxId }, { delay: TOKEN_REFRESH_INTERVAL_MS });
  }
}
