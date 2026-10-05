import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { inboxes, dnsChecks, poolMembers } from '@/db/schema';
import { BillingService } from '@/billing/billing.service';
import { encrypt } from '@/common/crypto';
import { ImapClientService } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { QueueService } from '@/queue/queue.service';
import { providerEndpoints } from './provider-config';
import { MailboxLinkError } from './oauth/mailbox-link-error';
import { DnsService, outcomeToBoolean } from '@/monitor/dns.service';

/**
 * Columns safe to return to the frontend — excludes oauthAccessToken,
 * oauthRefreshToken, smtpPass, imapPass, oauthClientSecret (all
 * AES-256-GCM ciphertext, but there's no reason to ship ciphertext blobs
 * to the browser at all). Used by findByUser/findById (T020/Wave 7
 * read endpoints) — the pre-existing connectGmail/connectOutlook/
 * connectCustomSmtp responses are unchanged, out of this task's scope.
 */
const SAFE_INBOX_COLUMNS = {
  id: inboxes.id,
  userId: inboxes.userId,
  email: inboxes.email,
  provider: inboxes.provider,
  oauthProvider: inboxes.oauthProvider,
  oauthClientId: inboxes.oauthClientId,
  oauthTokenExpiry: inboxes.oauthTokenExpiry,
  smtpHost: inboxes.smtpHost,
  smtpPort: inboxes.smtpPort,
  smtpUser: inboxes.smtpUser,
  imapHost: inboxes.imapHost,
  imapPort: inboxes.imapPort,
  imapUser: inboxes.imapUser,
  dkimSelector: inboxes.dkimSelector,
  sendingIp: inboxes.sendingIp,
  warmupSpeed: inboxes.warmupSpeed,
  warmupDay: inboxes.warmupDay,
  status: inboxes.status,
  statusReason: inboxes.statusReason,
  poolConsentAt: inboxes.poolConsentAt,
  enrolledInPoolAt: inboxes.enrolledInPoolAt,
  graduatedAt: inboxes.graduatedAt,
  createdAt: inboxes.createdAt,
};

const SECRET_INBOX_FIELDS = [
  'oauthAccessToken',
  'oauthRefreshToken',
  'oauthClientSecret',
  'smtpPass',
  'imapPass',
] as const;

/** Strips credential ciphertext from a full row before it leaves the API. */
export function toSafeInbox<T extends Record<string, unknown>>(
  row: T,
): Omit<T, (typeof SECRET_INBOX_FIELDS)[number]> {
  const copy: Record<string, unknown> = { ...row };
  for (const field of SECRET_INBOX_FIELDS) delete copy[field];
  return copy as Omit<T, (typeof SECRET_INBOX_FIELDS)[number]>;
}

/**
 * Per-entry shape accepted by both `POST /inboxes/batch` (this service) and
 * `POST /pool-inboxes/batch` (PoolInboxService). Loosely typed (not the
 * class-validator DTO) because both the JSON-body path (already validated
 * by `BatchUploadDto`) and the CSV path (parsed by `csv-parser.ts`, no
 * class-validator involved) funnel through here.
 */
export interface BatchInboxEntry {
  email: string;
  provider: 'gmail' | 'outlook' | 'custom';
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
}

/**
 * Structural validation for one batch entry. Returns a human-readable
 * reason string when invalid, or null when valid. Mirrors the per-provider
 * required-field rules in `BatchInboxEntryDto` — duplicated here (rather
 * than reused) because CSV rows never pass through class-validator.
 */
export function validateBatchEntry(entry: BatchInboxEntry): string | null {
  if (!entry || typeof entry !== 'object') return 'malformed entry';
  if (!entry.email || typeof entry.email !== 'string') return 'email is required';
  if (!['gmail', 'outlook', 'custom'].includes(entry.provider)) {
    return `unrecognized provider: '${entry.provider}' (expected gmail, outlook, or custom)`;
  }

  if (entry.provider === 'gmail' || entry.provider === 'outlook') {
    const missing: string[] = [];
    if (!entry.clientId) missing.push('clientId');
    if (!entry.clientSecret) missing.push('clientSecret');
    if (!entry.refreshToken) missing.push('refreshToken');
    if (missing.length > 0) return `missing required field(s): ${missing.join(', ')}`;
    return null;
  }

  // custom
  const missing: string[] = [];
  if (!entry.smtpHost) missing.push('smtpHost');
  if (entry.smtpPort == null || !Number.isFinite(Number(entry.smtpPort))) missing.push('smtpPort');
  if (!entry.smtpUser) missing.push('smtpUser');
  if (!entry.smtpPassword) missing.push('smtpPassword');
  if (!entry.imapHost) missing.push('imapHost');
  if (entry.imapPort == null || !Number.isFinite(Number(entry.imapPort))) missing.push('imapPort');
  if (!entry.imapUser) missing.push('imapUser');
  if (!entry.imapPassword) missing.push('imapPassword');
  if (missing.length > 0) return `missing required field(s): ${missing.join(', ')}`;
  return null;
}

/**
 * Builds the Drizzle insert payload for the `inboxes` table from a
 * validated batch entry. Assumes `validateBatchEntry` already passed —
 * does not re-validate. All secret fields are `encrypt()`-ed here, never
 * left plaintext.
 */
export function buildInboxInsertValues(userId: string, entry: BatchInboxEntry) {
  if (entry.provider === 'gmail' || entry.provider === 'outlook') {
    return {
      userId,
      email: entry.email,
      provider: entry.provider,
      oauthProvider: entry.provider === 'gmail' ? 'google' : 'microsoft',
      oauthClientId: entry.clientId!,
      oauthClientSecret: encrypt(entry.clientSecret!),
      oauthRefreshToken: encrypt(entry.refreshToken!),
      status: 'pending',
    };
  }

  return {
    userId,
    email: entry.email,
    provider: 'custom' as const,
    smtpHost: entry.smtpHost!,
    smtpPort: Number(entry.smtpPort),
    smtpUser: entry.smtpUser!,
    smtpPass: encrypt(entry.smtpPassword!),
    imapHost: entry.imapHost!,
    imapPort: Number(entry.imapPort),
    imapUser: entry.imapUser!,
    imapPass: encrypt(entry.imapPassword!),
    status: 'pending',
  };
}

@Injectable()
export class InboxService {
  constructor(
    @InjectPinoLogger(InboxService.name)
    private readonly logger: PinoLogger,
    private readonly billing: BillingService,
    private readonly imap: ImapClientService,
    private readonly smtp: SmtpClientService,
    private readonly queue: QueueService,
    private readonly dns: DnsService,
  ) {}

  /**
   * Stores a mailbox that was just authorized through the OAuth linking flow
   * (see MailboxLinkService, which has already validated the state and
   * exchanged the code) and runs the connection pre-check.
   *
   * The address comes from the provider's ID token, never from the client.
   * Linking a mailbox this user already has re-links it in place: new
   * tokens, status back to pending, then the same pre-check — which is how
   * a mailbox whose access was revoked is reconnected. A mailbox that is
   * already connected under a different account is refused.
   */
  async connectOAuthMailbox(
    userId: string,
    provider: 'gmail' | 'outlook',
    tokens: { access_token: string; refresh_token: string; expires_in: number; email: string },
    opts: { poolConsent?: boolean } = {},
  ) {
    const email = tokens.email.toLowerCase();
    this.logger.info({ userId, provider }, 'inbox connect attempt');

    const sameAddress = await db
      .select()
      .from(inboxes)
      .where(sql`lower(${inboxes.email}) = ${email}`);
    const mine = sameAddress.find((row) => row.userId === userId);
    if (!mine && sameAddress.some((row) => row.status !== 'disconnected')) {
      throw new MailboxLinkError(
        'duplicate',
        'This mailbox is already connected to another account.',
      );
    }

    const endpoints = providerEndpoints(provider);
    const credentials = {
      provider,
      oauthProvider: provider === 'gmail' ? 'google' : 'microsoft',
      oauthAccessToken: encrypt(tokens.access_token),
      oauthRefreshToken: encrypt(tokens.refresh_token),
      oauthTokenExpiry: new Date(Date.now() + (tokens.expires_in || 1800) * 1000),
      // Tokens now belong to the platform's OAuth app, not a customer-supplied one.
      oauthClientId: null,
      oauthClientSecret: null,
      imapHost: endpoints.imap.host,
      imapPort: endpoints.imap.port,
      smtpHost: endpoints.smtp.host,
      smtpPort: endpoints.smtp.port,
      status: 'pending',
      statusReason: null,
    };

    let inbox: typeof inboxes.$inferSelect;
    if (mine) {
      // Drop any pooled connection still authenticated with the old grant.
      await this.imap.close(mine.id).catch(() => undefined);
      [inbox] = await db
        .update(inboxes)
        .set(credentials)
        .where(eq(inboxes.id, mine.id))
        .returning();
    } else {
      try {
        // Reserve the plan slot and insert atomically (race-safe cap).
        [inbox] = await this.billing.withReservedInboxSlot(userId, (tx) =>
          tx.insert(inboxes).values({ userId, email, ...credentials }).returning(),
        );
      } catch (err: any) {
        if (err instanceof ForbiddenException) {
          throw new MailboxLinkError(
            'limit',
            err?.message ?? 'Inbox limit reached for your plan.',
          );
        }
        throw err;
      }
    }
    this.logger.info(
      { userId, inboxId: inbox.id, provider, relinked: Boolean(mine) },
      'inbox connect attempt',
    );

    let precheck;
    try {
      precheck = await this.runPrecheck(
        inbox.id,
        provider,
        opts.poolConsent === true || Boolean(mine?.poolConsentAt),
      );
    } catch (err: any) {
      throw new MailboxLinkError(
        'connection_failed',
        `Connected, but the mailbox did not pass the ${err?.step ?? 'connection'} check: ${
          err?.message ?? 'unknown error'
        }`.slice(0, 300),
      );
    }

    await this.queue.addTokenRefresh({ inboxId: inbox.id }, { delay: 45 * 60 * 1000 });

    return { inbox: toSafeInbox(inbox), precheck };
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
      poolConsent?: boolean;
    },
  ) {
    this.logger.info(
      {
        userId,
        provider: 'custom',
        email: dto.email,
        smtpHost: dto.smtpHost,
        smtpPort: dto.smtpPort,
      },
      'inbox connect attempt',
    );

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

    // Reserve the plan slot and insert atomically so two concurrent connects
    // cannot both slip past the cap (see BillingService.withReservedInboxSlot).
    const [inbox] = await this.billing.withReservedInboxSlot(userId, (tx) =>
      tx
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
        .returning(),
    );

    let precheck;
    try {
      precheck = await this.runPrecheck(inbox.id, 'custom', dto.poolConsent === true);
    } catch (err) {
      // Nothing was connected: don't leave a pending row behind that would
      // count against the plan's inbox limit and hold unusable credentials.
      await this.imap.close(inbox.id).catch(() => undefined);
      await db.delete(inboxes).where(eq(inboxes.id, inbox.id));
      throw err;
    }
    return { inbox: toSafeInbox(inbox), precheck };
  }

  /**
   * Records or withdraws the owner's consent to take part in the shared
   * warmup pool. Consent is only ever set by this explicit call (or the
   * explicit flag on a connect request) — never inferred from a passing
   * health check.
   *
   * Granting enrolls the inbox as a pool member if it can receive (IMAP).
   * Withdrawing takes it out of pairing immediately and drops engagement
   * jobs still queued for it; sends reserved to or from it are canceled at
   * dispatch by the send worker's own eligibility check. Mail a server has
   * already accepted cannot be recalled.
   */
  async setPoolConsent(userId: string, inboxId: string, granted: boolean) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) return null;

    if (!granted) {
      await db.update(inboxes).set({ poolConsentAt: null }).where(eq(inboxes.id, inboxId));
      await db.update(poolMembers).set({ active: false }).where(eq(poolMembers.inboxId, inboxId));
      await this.queue.removeJobsForReceiver('warmup-receive', inboxId);
      this.logger.info({ userId, inboxId }, 'pool consent withdrawn');
      return { id: inboxId, poolConsentAt: null, enrolled: false };
    }

    const poolConsentAt = inbox.poolConsentAt ?? new Date();
    await db.update(inboxes).set({ poolConsentAt }).where(eq(inboxes.id, inboxId));
    const enrolled = inbox.status === 'active' && (await this.enrollInPool(inbox));
    this.logger.info({ userId, inboxId, enrolled }, 'pool consent recorded');
    return { id: inboxId, poolConsentAt, enrolled };
  }

  /**
   * Makes the inbox an active shared-pool member. Requires IMAP: the warmup
   * engine has to confirm delivery, mark-as-read, reply and rescue from
   * spam, which a send-only inbox can't do. Reuses an existing membership
   * row rather than adding a duplicate.
   */
  private async enrollInPool(inbox: typeof inboxes.$inferSelect): Promise<boolean> {
    const canReceive =
      inbox.provider !== 'custom' ||
      Boolean(inbox.imapHost && inbox.imapPort && inbox.imapUser && inbox.imapPass);
    if (!canReceive) return false;

    const existing = await db
      .select()
      .from(poolMembers)
      .where(eq(poolMembers.inboxId, inbox.id))
      .limit(1);
    if (existing[0]) {
      await db
        .update(poolMembers)
        .set({ active: true })
        .where(and(eq(poolMembers.inboxId, inbox.id), eq(poolMembers.quarantined, false)));
    } else {
      await db.insert(poolMembers).values({
        inboxId: inbox.id,
        email: inbox.email,
        domain: inbox.email.split('@')[1].toLowerCase(),
        provider: inbox.provider,
        reputation: 50,
        active: true,
        quarantined: false,
      });
    }
    await db
      .update(inboxes)
      .set({ enrolledInPoolAt: inbox.enrolledInPoolAt ?? new Date() })
      .where(eq(inboxes.id, inbox.id));
    return true;
  }

  async findByUser(userId: string) {
    return db.select(SAFE_INBOX_COLUMNS).from(inboxes).where(eq(inboxes.userId, userId));
  }

  /** Ownership-checked single-row lookup for `GET /inboxes/:id`. Returns
   * null (not throw) when not found/not owned — the controller maps that
   * to a 404. No analysis join here; a later step attaches the latest
   * `inbox_analysis` row at the controller layer. */
  async findById(userId: string, inboxId: string) {
    const rows = await db
      .select(SAFE_INBOX_COLUMNS)
      .from(inboxes)
      .where(eq(inboxes.id, inboxId))
      .limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) return null;
    return inbox;
  }

  /**
   * Batch-uploads inboxes-to-warm (T020). Accepts the same per-entry shape
   * as `POST /pool-inboxes/batch` (PoolInboxService.batchUpload) — only the
   * destination table and the column layout (flat columns here vs a single
   * `encryptedCredentials` JSONB blob there) differ. Each entry is
   * processed independently: structurally invalid entries, in-batch
   * duplicate emails, and duplicates against the user's existing inboxes
   * all land in `failed[]` rather than aborting the batch or crashing on a
   * DB error (inboxes.email has no unique constraint, so this is purely an
   * application-level check, not a 23505 catch).
   */
  async batchUpload(
    userId: string,
    entries: BatchInboxEntry[],
  ): Promise<{ created: number; failed: { email: string; reason: string }[] }> {
    const failed: { email: string; reason: string }[] = [];
    const createdInboxIds: string[] = [];

    // The whole batch reserves its slots inside one locked transaction so a
    // concurrent connect or a second parallel import cannot share-count the
    // same free slots and together overrun the plan cap. Rows past the limit,
    // in-batch duplicates and malformed rows land in `failed[]` — the batch
    // never aborts (T020 partial success).
    await db.transaction(async (tx) => {
      let slotsLeft = await this.billing.lockInboxSlots(tx, userId);
      const existingRows = await tx
        .select({ email: inboxes.email })
        .from(inboxes)
        .where(eq(inboxes.userId, userId));
      const existingEmails = new Set(existingRows.map((r) => r.email.toLowerCase()));
      const seenInBatch = new Set<string>();

      for (const entry of entries) {
        const email = entry?.email ?? '(unknown)';
        try {
          const validationError = validateBatchEntry(entry);
          if (validationError) {
            failed.push({ email, reason: validationError });
            continue;
          }

          const normalizedEmail = entry.email.toLowerCase();
          if (existingEmails.has(normalizedEmail) || seenInBatch.has(normalizedEmail)) {
            failed.push({ email, reason: 'duplicate email — already exists for this user' });
            continue;
          }

          if (slotsLeft <= 0) {
            failed.push({ email, reason: 'inbox limit reached for your plan' });
            continue;
          }

          const values = buildInboxInsertValues(userId, entry);
          // Each insert runs in its own savepoint (a nested drizzle
          // transaction). A row-level DB error rolls back only that savepoint —
          // in plain Postgres a failed statement aborts the whole transaction
          // and poisons every later command, so the savepoint is what keeps
          // the batch's partial-success contract intact.
          const [inbox] = await tx.transaction((sp) =>
            sp.insert(inboxes).values(values).returning(),
          );

          seenInBatch.add(normalizedEmail);
          createdInboxIds.push(inbox.id);
          slotsLeft -= 1;
        } catch (err: any) {
          failed.push({ email, reason: err?.message || 'failed to process row' });
        }
      }
    });

    // Enqueue analysis only after the slots are durably committed.
    for (const inboxId of createdInboxIds) {
      await this.queue.add('inbox-analysis', { inboxId, userId });
    }

    return { created: createdInboxIds.length, failed };
  }

  private async runPrecheck(inboxId: string, provider: string, poolConsent = false) {
    this.logger.info({ inboxId, provider }, 'precheck started');
    // Each step is one of:
    //   true  — step passed
    //   false — step attempted and failed (terminal — precheck throws)
    //   'skipped' — step not applicable (e.g. user opted out of IMAP for a
    //               custom SMTP inbox). Counts as "fine" for the
    //               all-of-activation check.
    const steps: Record<string, boolean | 'skipped'> = {};
    // `detail` mirrors `steps` but carries the host/port/timing/mailbox-count
    // the frontend's inline connection-test result needs (T028 §5) — kept
    // separate from `steps` so existing callers asserting on the bare
    // boolean shape are unaffected.
    const detail: {
      smtp?: { ok: boolean; host?: string; port?: number; ms: number };
      imap?: { ok: boolean; host?: string; port?: number; ms: number; mailboxCount?: number };
    } = {};
    let hasImap = false;

    const lookupRow = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inboxRow = lookupRow[0];

    const smtpStart = Date.now();
    try {
      await this.smtp.verify(inboxId);
      steps.smtp = true;
      detail.smtp = {
        ok: true,
        host: inboxRow?.smtpHost ?? undefined,
        port: inboxRow?.smtpPort ?? undefined,
        ms: Date.now() - smtpStart,
      };
      this.logger.info({ inboxId, provider }, 'precheck passed: smtp');
    } catch (err: any) {
      steps.smtp = false;
      this.logger.error(
        { inboxId, provider, err: err?.message, errCode: err?.code },
        'precheck failed: smtp',
      );
      throw Object.assign(new Error(err.message || 'SMTP verification failed'), {
        step: 'smtp',
        errCode: err?.code,
        host: inboxRow?.smtpHost,
        port: inboxRow?.smtpPort,
      });
    }

    // IMAP is optional. For custom inboxes where the user didn't supply
    // IMAP creds, we mark imap='skipped' (not false) and do NOT throw —
    // the inbox can still send via SMTP. For Gmail/Outlook (OAuth) IMAP
    // is always available via the XOAUTH2 token, so we always verify it.
    let imapAttempted = false;
    let imapFailure: Error | null = null;
    const imapStart = Date.now();
    try {
      const client = await this.imap.getConnection(inboxId);
      imapAttempted = true;
      // Check the listing rather than parsing a server-specific
      // "already exists" error (imapflow reports only "Command failed").
      let mailboxes = await client.list();
      if (!mailboxes.some((m) => m.path === 'WarmupHub')) {
        await client.mailboxCreate('WarmupHub');
        mailboxes = await client.list();
      }
      await this.imap.close(inboxId);
      steps.imap = true;
      hasImap = true;
      detail.imap = {
        ok: true,
        host: inboxRow?.imapHost ?? undefined,
        port: inboxRow?.imapPort ?? undefined,
        ms: Date.now() - imapStart,
        mailboxCount: mailboxes.length,
      };
    } catch (err: any) {
      imapFailure = err;
      // We don't know yet whether the user supplied IMAP creds; the
      // ImapClientService throws ImapNotConfiguredError when the row has
      // no imapHost, and a generic Error otherwise. We can't query the
      // row inside this try/catch without re-ordering, so defer the
      // "throw or skip" decision to below.
    }

    if (!imapAttempted) {
      // We already have the row from the top of this method — reuse it to
      // see if the user actually supplied IMAP.
      const noImapConfigured = !inboxRow?.imapHost;
      if (provider !== 'custom' || !noImapConfigured) {
        // Either: OAuth provider (IMAP is mandatory), or: custom provider
        // with IMAP creds supplied that failed. Either way, fail.
        throw Object.assign(imapFailure ?? new Error('IMAP verification failed'), {
          step: 'imap',
          errCode: (imapFailure as any)?.code,
          host: inboxRow?.imapHost,
          port: inboxRow?.imapPort,
        });
      }
      // Custom provider, no IMAP creds — skip gracefully.
      steps.imap = 'skipped';
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    const domain = inbox.email.split('@')[1];

    const dnsResult = await this.checkDns(domain, inbox.dkimSelector, inbox.provider);
    await db.insert(dnsChecks).values({
      inboxId,
      spfValid: dnsResult.spf,
      dkimValid: dnsResult.dkim,
      dmarcValid: dnsResult.dmarc,
      mxValid: dnsResult.mx,
    });
    // What blocks activation is a definite problem with the two records mail
    // flow depends on: SPF and MX. A lookup that could not be completed, an
    // unverifiable DKIM selector, or a missing DMARC record are recorded and
    // shown as health issues but do not stop the inbox from warming.
    steps.dns = dnsResult.spf !== false && dnsResult.mx !== false;

    // Inbox is "active" when SMTP and DNS both pass. 'skipped' counts as
    // pass; 'true' counts as pass; 'false' would have thrown above.
    const activationPass = steps.smtp === true && steps.dns === true && steps.imap !== false;
    if (activationPass) {
      // Conditional on 'pending' so a slow precheck can't re-activate an
      // inbox that was paused or removed in the meantime. Pool consent is
      // recorded only when the owner explicitly gave it on this request.
      await db
        .update(inboxes)
        .set({ status: 'active', ...(poolConsent ? { poolConsentAt: new Date() } : {}) })
        .where(and(eq(inboxes.id, inboxId), eq(inboxes.status, 'pending')));
      this.logger.info(
        { inboxId, provider, fromStatus: 'pending', toStatus: 'active' },
        'inbox status changed',
      );
    }
    this.logger.info({ inboxId, provider, activationPass, steps }, 'precheck completed');

    // Shared-pool enrollment needs both explicit consent and working IMAP.
    if (activationPass && hasImap && poolConsent) {
      await this.enrollInPool(inbox);
    }

    return { ...steps, detail };
  }

  /**
   * SPF, DKIM, DMARC and MX for a newly connected inbox, using the same
   * checks as ongoing monitoring. Each value is true (pass), false (fail) or
   * null (could not be determined) — DKIM in particular is null unless a key
   * was actually read.
   */
  private async checkDns(
    domain: string,
    dkimSelector: string | null,
    provider: string,
  ): Promise<{
    spf: boolean | null;
    dkim: boolean | null;
    dmarc: boolean | null;
    mx: boolean | null;
  }> {
    const [spf, dkim, dmarc, mx] = await Promise.all([
      this.dns.checkSpf(domain),
      this.dns.checkDkimForInbox(domain, dkimSelector, provider),
      this.dns.checkDmarc(domain),
      this.dns.checkMx(domain),
    ]);
    return {
      spf: outcomeToBoolean(spf),
      dkim: outcomeToBoolean(dkim),
      dmarc: outcomeToBoolean(dmarc),
      mx: outcomeToBoolean(mx),
    };
  }
}
