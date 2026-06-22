import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes, poolInboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { GoogleOAuthService } from '../oauth/google-oauth.service';
import { MicrosoftOAuthService } from '../oauth/microsoft-oauth.service';

@Injectable()
export class SmtpClientService {
  constructor(
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly microsoftOAuthService: MicrosoftOAuthService,
  ) {}

  async verify(inboxId: string): Promise<void> {
    const transporter = await this.getTransporter(inboxId);
    await transporter.verify();
  }

  async getTransporter(inboxId: string) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    if (inbox.provider === 'gmail' || inbox.provider === 'outlook') {
      return nodemailer.createTransport({
        host: inbox.smtpHost || 'smtp.gmail.com',
        port: inbox.smtpPort || 465,
        secure: true,
        auth: {
          type: 'OAuth2',
          user: inbox.email,
          accessToken: decrypt(inbox.oauthAccessToken!),
        },
      });
    }

    return nodemailer.createTransport({
      host: inbox.smtpHost!,
      port: inbox.smtpPort || 587,
      secure: (inbox.smtpPort || 587) === 465,
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

    if (poolInbox.provider === 'gmail' || poolInbox.provider === 'outlook') {
      const clientId = creds.clientId as string | undefined;
      const clientSecretEncrypted = creds.clientSecret as string | undefined;
      const refreshTokenEncrypted = creds.refreshToken as string | undefined;
      if (!clientId || !clientSecretEncrypted || !refreshTokenEncrypted) {
        throw new Error(`OAuth credentials missing for pool inbox ${poolInboxId}`);
      }

      const clientSecret = decrypt(clientSecretEncrypted);
      const refreshToken = decrypt(refreshTokenEncrypted);
      const oauthService =
        poolInbox.provider === 'gmail' ? this.googleOAuthService : this.microsoftOAuthService;
      const { access_token } = await oauthService.refreshToken(refreshToken, {
        clientId,
        clientSecret,
      });

      return nodemailer.createTransport({
        host: poolInbox.provider === 'gmail' ? 'smtp.gmail.com' : 'smtp.office365.com',
        port: 465,
        secure: true,
        auth: {
          type: 'OAuth2',
          user: poolInbox.email,
          accessToken: access_token,
        },
      });
    }

    const smtpHost = creds.smtpHost as string | undefined;
    const smtpPort = creds.smtpPort as number | undefined;
    const smtpUser = creds.smtpUser as string | undefined;
    const smtpPasswordEncrypted = creds.smtpPassword as string | undefined;
    if (!smtpHost || !smtpUser || !smtpPasswordEncrypted) {
      throw new Error(`SMTP credentials missing for pool inbox ${poolInboxId}`);
    }

    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort || 587,
      secure: (smtpPort || 587) === 465,
      auth: {
        user: smtpUser,
        pass: decrypt(smtpPasswordEncrypted),
      },
    });
  }
}
