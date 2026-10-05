import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as nodemailer from 'nodemailer';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes, poolInboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { MailCredentialService } from '../oauth/mail-credential.service';
import { assertPort, resolvePublicHost } from '../../common/egress-policy';
import {
  MAIL_TIMEOUTS,
  isOAuthProvider,
  providerEndpoints,
  smtpTlsOptions,
} from '../provider-config';

const SMTP_TIMEOUTS = {
  connectionTimeout: MAIL_TIMEOUTS.connection,
  greetingTimeout: MAIL_TIMEOUTS.greeting,
  socketTimeout: MAIL_TIMEOUTS.socket,
};

@Injectable()
export class SmtpClientService {
  constructor(
    @InjectPinoLogger(SmtpClientService.name)
    private readonly logger: PinoLogger,
    private readonly credentials: MailCredentialService,
  ) {}

  async verify(inboxId: string): Promise<void> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    this.logger.info(
      {
        inboxId,
        provider: inbox?.provider,
        smtpHost: inbox?.smtpHost,
        smtpPort: inbox?.smtpPort,
      },
      'SMTP verify started',
    );
    const transporter = await this.getTransporter(inboxId);
    try {
      await transporter.verify();
      this.logger.info({ inboxId, provider: inbox?.provider }, 'SMTP verify succeeded');
    } catch (err: any) {
      this.logger.error(
        {
          inboxId,
          provider: inbox?.provider,
          smtpHost: inbox?.smtpHost,
          smtpPort: inbox?.smtpPort,
          err: err?.message,
          errCode: err?.code,
          errResponseCode: err?.responseCode,
        },
        'SMTP verify failed',
      );
      throw err;
    }
  }

  async getTransporter(inboxId: string) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    if (isOAuthProvider(inbox.provider)) {
      const endpoint = providerEndpoints(inbox.provider).smtp;
      const host = inbox.smtpHost || endpoint.host;
      const port = inbox.smtpPort || endpoint.port;
      this.logger.debug(
        { inboxId, provider: inbox.provider, smtpHost: host, smtpPort: port },
        'building OAuth2 SMTP transporter',
      );
      // Refreshed on demand; never the raw stored token, which expires hourly.
      const accessToken = await this.credentials.getInboxAccessToken(inboxId);
      return nodemailer.createTransport({
        host,
        port,
        ...smtpTlsOptions(port),
        ...SMTP_TIMEOUTS,
        auth: {
          type: 'OAuth2',
          user: inbox.email,
          accessToken,
        },
      });
    }

    const port = assertPort(inbox.smtpPort || 587);
    this.logger.debug(
      { inboxId, provider: inbox.provider, smtpHost: inbox.smtpHost, smtpPort: port },
      'building custom SMTP transporter',
    );
    // Customer-supplied host: connect to the address that passed the egress
    // policy, keeping the name only for TLS.
    const target = await resolvePublicHost(inbox.smtpHost!);
    return nodemailer.createTransport({
      host: target.address,
      port,
      ...smtpTlsOptions(port),
      ...(target.servername ? { tls: { servername: target.servername } } : {}),
      ...SMTP_TIMEOUTS,
      auth: {
        user: inbox.smtpUser!,
        pass: decrypt(inbox.smtpPass!),
      },
    });
  }

  /**
   * Pool-inbox-aware transporter. Loads `pool_inboxes`, parses
   * `encrypted_credentials` per the contract documented in T022, and builds
   * the nodemailer transporter the same way getTransporter does for the
   * inboxes-table OAuth/custom branches — just sourcing fields from the
   * decrypted JSON blob instead of table columns.
   */
  async getPoolInboxTransporter(poolInboxId: string) {
    const rows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, poolInboxId))
      .limit(1);
    const poolInbox = rows[0];
    if (!poolInbox) throw new Error('Pool inbox not found');

    const creds = (poolInbox.encryptedCredentials ?? {}) as Record<string, unknown>;

    if (isOAuthProvider(poolInbox.provider)) {
      const endpoint = providerEndpoints(poolInbox.provider).smtp;
      const accessToken = await this.credentials.getPoolInboxAccessToken(poolInboxId);
      return nodemailer.createTransport({
        host: endpoint.host,
        port: endpoint.port,
        ...smtpTlsOptions(endpoint.port),
        ...SMTP_TIMEOUTS,
        auth: {
          type: 'OAuth2',
          user: poolInbox.email,
          accessToken,
        },
      });
    }

    const smtpHost = creds.smtpHost as string | undefined;
    const smtpPort = Number(creds.smtpPort) || 587;
    const smtpUser = creds.smtpUser as string | undefined;
    const smtpPasswordEncrypted = creds.smtpPassword as string | undefined;
    if (!smtpHost || !smtpUser || !smtpPasswordEncrypted) {
      throw new Error(`SMTP credentials missing for pool inbox ${poolInboxId}`);
    }

    this.logger.debug(
      { poolInboxId, provider: poolInbox.provider, smtpHost, smtpPort },
      'building custom SMTP transporter (pool inbox)',
    );
    const target = await resolvePublicHost(smtpHost);
    assertPort(smtpPort);
    return nodemailer.createTransport({
      host: target.address,
      port: smtpPort,
      ...smtpTlsOptions(smtpPort),
      ...(target.servername ? { tls: { servername: target.servername } } : {}),
      ...SMTP_TIMEOUTS,
      auth: {
        user: smtpUser,
        pass: decrypt(smtpPasswordEncrypted),
      },
    });
  }

  /** Verifies a pool inbox can authenticate for SMTP submission. */
  async verifyPoolInbox(poolInboxId: string): Promise<void> {
    const transporter = await this.getPoolInboxTransporter(poolInboxId);
    await transporter.verify();
  }

  /**
   * Sends an email through the transporter built for `inboxId` and emits
   * the canonical T025 log lines (info on success, error on failure with
   * `errCode` + `errResponseCode` + `smtpHost` + `smtpPort` so SMTP errors
   * are diagnosable from the terminal). Used by the warmup-send path; the
   * connect/precheck flows call `verify()`, which has its own log lines.
   */
  async sendMail(
    inboxId: string,
    options: Parameters<ReturnType<typeof nodemailer.createTransport>['sendMail']>[0],
  ): Promise<{ messageId: string }> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    const transporter = await this.getTransporter(inboxId);
    try {
      const result = await transporter.sendMail(options);
      this.logger.info(
        {
          inboxId,
          provider: inbox?.provider,
          to: options.to,
          messageId: result.messageId,
        },
        'SMTP send succeeded',
      );
      return { messageId: result.messageId };
    } catch (err: any) {
      this.logger.error(
        {
          inboxId,
          provider: inbox?.provider,
          smtpHost: inbox?.smtpHost,
          smtpPort: inbox?.smtpPort,
          to: options.to,
          err: err?.message,
          errCode: err?.code,
          errResponseCode: err?.responseCode,
        },
        'SMTP send failed',
      );
      throw err;
    }
  }
}
