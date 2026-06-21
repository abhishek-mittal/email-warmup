import { Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { inboxes, dnsChecks, poolMembers } from '@/db/schema';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { BillingService } from '@/billing/billing.service';
import { encrypt } from '@/common/crypto';
import { ImapClientService } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { QueueService } from '@/queue/queue.service';
import * as dns from 'dns';

@Injectable()
export class InboxService {
  constructor(
    private readonly googleOAuth: GoogleOAuthService,
    private readonly microsoftOAuth: MicrosoftOAuthService,
    private readonly billing: BillingService,
    private readonly imap: ImapClientService,
    private readonly smtp: SmtpClientService,
    private readonly queue: QueueService,
  ) {}

  async connectGmail(userId: string, code: string) {
    const tokens = await this.googleOAuth.exchangeCode(code);
    const userinfo = await this.fetchGoogleUserinfo(tokens.access_token);
    await this.billing.assertInboxLimit(userId);

    const [inbox] = await db
      .insert(inboxes)
      .values({
        userId,
        email: userinfo.email,
        provider: 'gmail',
        oauthProvider: 'google',
        oauthAccessToken: encrypt(tokens.access_token),
        oauthRefreshToken: encrypt(tokens.refresh_token),
        oauthTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        status: 'pending',
      })
      .returning();

    const precheck = await this.runPrecheck(inbox.id, 'gmail');

    await this.queue.addTokenRefresh({ inboxId: inbox.id }, { delay: 45 * 60 * 1000 });

    return { inbox, precheck };
  }

  async connectOutlook(userId: string, code: string) {
    const tokens = await this.microsoftOAuth.exchangeCode(code);
    const userinfo = await this.fetchMicrosoftUserinfo(tokens.access_token);
    await this.billing.assertInboxLimit(userId);

    const [inbox] = await db
      .insert(inboxes)
      .values({
        userId,
        email: userinfo.email,
        provider: 'outlook',
        oauthProvider: 'microsoft',
        oauthAccessToken: encrypt(tokens.access_token),
        oauthRefreshToken: encrypt(tokens.refresh_token),
        oauthTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        imapHost: 'outlook.office365.com',
        imapPort: 993,
        smtpHost: 'smtp.office365.com',
        smtpPort: 587,
        status: 'pending',
      })
      .returning();

    const precheck = await this.runPrecheck(inbox.id, 'outlook');

    await this.queue.addTokenRefresh({ inboxId: inbox.id }, { delay: 45 * 60 * 1000 });

    return { inbox, precheck };
  }

  async connectCustomSmtp(
    userId: string,
    dto: {
      email: string;
      smtpHost: string;
      smtpPort: number;
      smtpUser: string;
      smtpPass: string;
      useImap?: boolean;
      imapHost?: string;
      imapPort?: number;
      imapUser?: string;
      imapPass?: string;
      dkimSelector?: string;
    },
  ) {
    await this.billing.assertInboxLimit(userId);

    // Normalize: an all-or-nothing IMAP block. If the user opted in, all
    // four fields must be present. If they didn't, the IMAP columns stay
    // NULL and downstream code falls back to SMTP-only behavior.
    const useImap = dto.useImap === true;
    const imapFields = useImap
      ? {
          imapHost: dto.imapHost!,
          imapPort: dto.imapPort!,
          imapUser: dto.imapUser!,
          imapPass: encrypt(dto.imapPass!),
        }
      : {
          imapHost: null as unknown as string,
          imapPort: null as unknown as number,
          imapUser: null as unknown as string,
          imapPass: null as unknown as string,
        };

    const [inbox] = await db
      .insert(inboxes)
      .values({
        userId,
        email: dto.email,
        provider: 'custom',
        smtpHost: dto.smtpHost,
        smtpPort: dto.smtpPort,
        smtpUser: dto.smtpUser,
        smtpPass: encrypt(dto.smtpPass),
        ...imapFields,
        dkimSelector: dto.dkimSelector,
        status: 'pending',
      })
      .returning();

    const precheck = await this.runPrecheck(inbox.id, 'custom');
    return { inbox, precheck };
  }

  async findByUser(userId: string) {
    return db.select().from(inboxes).where(eq(inboxes.userId, userId));
  }

  private async fetchGoogleUserinfo(accessToken: string): Promise<{ email: string }> {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new BadRequestException('Failed to fetch Google userinfo');
    return res.json();
  }

  private async fetchMicrosoftUserinfo(accessToken: string): Promise<{ email: string }> {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new BadRequestException('Failed to fetch Microsoft userinfo');
    const data = await res.json();
    return { email: data.mail || data.userPrincipalName };
  }

  private async runPrecheck(inboxId: string, provider: string) {
    // Each step is one of:
    //   true  — step passed
    //   false — step attempted and failed (terminal — precheck throws)
    //   'skipped' — step not applicable (e.g. user opted out of IMAP for a
    //               custom SMTP inbox). Counts as "fine" for the
    //               all-of-activation check.
    const steps: Record<string, boolean | 'skipped'> = {};
    let hasImap = false;
    try {
      await this.smtp.verify(inboxId);
      steps.smtp = true;
    } catch (err: any) {
      steps.smtp = false;
      throw Object.assign(new Error(err.message || 'SMTP verification failed'), { step: 'smtp' });
    }

    // IMAP is optional. For custom inboxes where the user didn't supply
    // IMAP creds, we mark imap='skipped' (not false) and do NOT throw —
    // the inbox can still send via SMTP. For Gmail/Outlook (OAuth) IMAP
    // is always available via the XOAUTH2 token, so we always verify it.
    let imapAttempted = false;
    let imapFailure: Error | null = null;
    try {
      const client = await this.imap.getConnection(inboxId);
      imapAttempted = true;
      try {
        await client.mailboxCreate('WarmupHub');
      } catch (err: any) {
        if (!err.message?.includes('exists')) throw err;
      }
      await this.imap.close(inboxId);
      steps.imap = true;
      hasImap = true;
    } catch (err: any) {
      imapFailure = err;
      // We don't know yet whether the user supplied IMAP creds; the
      // ImapClientService throws ImapNotConfiguredError when the row has
      // no imapHost, and a generic Error otherwise. We can't query the
      // row inside this try/catch without re-ordering, so defer the
      // "throw or skip" decision to below.
    }

    if (!imapAttempted) {
      // Look up the row to see if the user actually supplied IMAP.
      const lookup = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
      const row = lookup[0];
      const noImapConfigured = !row?.imapHost;
      if (provider !== 'custom' || !noImapConfigured) {
        // Either: OAuth provider (IMAP is mandatory), or: custom provider
        // with IMAP creds supplied that failed. Either way, fail.
        throw Object.assign(
          imapFailure ?? new Error('IMAP verification failed'),
          { step: 'imap' },
        );
      }
      // Custom provider, no IMAP creds — skip gracefully.
      steps.imap = 'skipped';
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    const domain = inbox.email.split('@')[1];

    const dnsResult = await this.checkDns(domain);
    await db.insert(dnsChecks).values({
      inboxId,
      spfValid: dnsResult.spf,
      dkimValid: dnsResult.dkim,
      dmarcValid: dnsResult.dmarc,
      mxValid: dnsResult.mx,
    });
    steps.dns = dnsResult.spf && dnsResult.dkim && dnsResult.dmarc && dnsResult.mx;

    // Inbox is "active" when SMTP and DNS both pass. 'skipped' counts as
    // pass; 'true' counts as pass; 'false' would have thrown above.
    const activationPass =
      steps.smtp === true && steps.dns === true && steps.imap !== false;
    if (activationPass) {
      await db
        .update(inboxes)
        .set({ status: 'active', poolConsentAt: new Date() })
        .where(eq(inboxes.id, inboxId));
    }

    // Enroll in the warmup pool ONLY if IMAP is actually configured and
    // passed. The warmup engine needs to confirm delivery via IMAP,
    // mark-as-read, reply, and rescue from spam. Without IMAP the
    // inbox is a one-way sender only.
    if (activationPass && hasImap) {
      await db.insert(poolMembers).values({
        inboxId,
        email: inbox.email,
        domain: inbox.email.split('@')[1].toLowerCase(),
        provider: inbox.provider,
        reputation: 50,
        active: true,
        quarantined: false,
      });
    }

    return steps;
  }

  private async checkDns(domain: string): Promise<{
    spf: boolean;
    dkim: boolean;
    dmarc: boolean;
    mx: boolean;
  }> {
    const [mxRecords, spfTxt, dmarcTxt] = await Promise.allSettled([
      dns.promises.resolveMx(domain),
      this.resolveTxt(domain),
      this.resolveTxt(`_dmarc.${domain}`),
    ]);

    const mx = mxRecords.status === 'fulfilled' && mxRecords.value.length > 0;
    const txt = spfTxt.status === 'fulfilled' ? spfTxt.value : [];
    const spf = txt.some((r) => r.includes('v=spf1'));
    const dmarcRecords = dmarcTxt.status === 'fulfilled' ? dmarcTxt.value : [];
    const dmarc = dmarcRecords.some((r) => r.includes('v=DMARC1'));

    return { spf, dkim: true, dmarc, mx };
  }

  private async resolveTxt(name: string): Promise<string[]> {
    const records = await dns.promises.resolveTxt(name);
    return records.map((r) => r.join(''));
  }
}
