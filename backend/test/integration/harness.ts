import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import * as nodemailer from 'nodemailer';
import type { Job } from 'bullmq';
import { db } from '../../src/db';
import { inboxes, poolInboxes, poolMembers, users, warmupSends } from '../../src/db/schema';
import { encrypt } from '../../src/common/crypto';
import { makePinoLoggerStub } from '../../src/common/pino-logger.stub';
import { ImapClientService } from '../../src/inbox/imap/imap-client.service';
import { SmtpClientService } from '../../src/inbox/smtp/smtp-client.service';
import { MailCredentialService } from '../../src/inbox/oauth/mail-credential.service';
import { ContentService } from '../../src/warmup/content.service';
import { WarmupLedgerService } from '../../src/warmup/warmup-ledger.service';
import { WarmupSendProcessor } from '../../src/warmup/warmup-send.processor';
import { WarmupReceiveProcessor } from '../../src/warmup/warmup-receive.processor';
import { PairingService } from '../../src/warmup/pairing.service';
import { RampService } from '../../src/warmup/ramp.service';
import { WarmupService } from '../../src/warmup/warmup.service';
import { QueueService } from '../../src/queue/queue.service';
import { SafetyStopService } from '../../src/safety/safety-stop.service';
import { BounceMonitorService } from '../../src/safety/bounce-monitor.service';

export const SMTP_HOST = process.env.TEST_SMTP_HOST!;
export const SMTP_PORT = Number(process.env.TEST_SMTP_PORT);
export const IMAP_HOST = process.env.TEST_IMAP_HOST!;
export const IMAP_PORT = Number(process.env.TEST_IMAP_PORT);
const MAIL_PASSWORD = 'mailbox-password';

export interface QueuedJob {
  queue: string;
  payload: any;
  opts: any;
}

/** Records what would be published; drain semantics mirror the real QueueService. */
export class FakeQueue {
  jobs: QueuedJob[] = [];
  failNextAdd = false;

  async add(queue: string, payload: any, opts?: any) {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error('queue unavailable');
    }
    // BullMQ ignores an add whose custom jobId already exists.
    if (opts?.jobId && this.jobs.some((j) => j.queue === queue && j.opts?.jobId === opts.jobId)) {
      return;
    }
    this.jobs.push({ queue, payload, opts });
  }
  async addTokenRefresh(payload: any, opts?: any) {
    return this.add('token-refresh', payload, opts);
  }
  async removeJobsForSender(queue: string, senderInboxId: string) {
    this.jobs = this.jobs.filter(
      (j) => !(j.queue === queue && j.payload.senderInboxId === senderInboxId),
    );
  }
  async removeJobsForReceiver(queue: string, receiverInboxId: string) {
    this.jobs = this.jobs.filter(
      (j) => !(j.queue === queue && j.payload.receiverInboxId === receiverInboxId),
    );
  }
  of(queue: string) {
    return this.jobs.filter((j) => j.queue === queue);
  }
}

/** Fixed content so tests never call the model API. */
export class FakeContent {
  async generateEmail() {
    return {
      subject: 'Quick hello',
      text: 'Hope your week is going well.',
      html: '<p>Hope your week is going well.</p>',
    };
  }
  async generateReply(original: { subject: string }) {
    return {
      subject: `Re: ${original.subject}`,
      text: 'Thanks, all good here.',
      html: '<p>Thanks, all good here.</p>',
    };
  }
}

export interface Engine {
  queue: FakeQueue;
  imap: ImapClientService;
  smtp: SmtpClientService;
  credentials: MailCredentialService;
  ledger: WarmupLedgerService;
  stops: SafetyStopService;
  bounces: BounceMonitorService;
  sendProcessor: WarmupSendProcessor;
  receiveProcessor: WarmupReceiveProcessor;
  pairing: PairingService;
  warmup: WarmupService;
  oauth: { refreshToken: jest.Mock };
}

/** Real services wired by hand; only the queue, content and OAuth HTTP are faked. */
export function buildEngine(): Engine {
  const queue = new FakeQueue();
  const oauth = { refreshToken: jest.fn() };
  const credentials = new MailCredentialService(
    makePinoLoggerStub(),
    oauth as any,
    oauth as any,
    queue as unknown as QueueService,
  );
  const imap = new ImapClientService(makePinoLoggerStub(), credentials);
  const smtp = new SmtpClientService(makePinoLoggerStub(), credentials);
  const content = new FakeContent() as unknown as ContentService;
  const ledger = new WarmupLedgerService(queue as unknown as QueueService);
  const stops = new SafetyStopService();
  const pairing = new PairingService();
  const warmup = new WarmupService(
    new RampService(),
    pairing,
    queue as unknown as QueueService,
    ledger,
    stops,
  );
  const bounces = new BounceMonitorService(
    makePinoLoggerStub(),
    imap,
    warmup,
    queue as unknown as QueueService,
  );
  const sendProcessor = new WarmupSendProcessor(
    makePinoLoggerStub(),
    content,
    smtp,
    ledger,
    stops,
    bounces,
  );
  const receiveProcessor = new WarmupReceiveProcessor(
    makePinoLoggerStub(),
    imap,
    smtp,
    content,
    ledger,
    stops,
  );
  return {
    queue,
    imap,
    smtp,
    credentials,
    ledger,
    stops,
    bounces,
    sendProcessor,
    receiveProcessor,
    pairing,
    warmup,
    oauth,
  };
}

export async function resetDb(): Promise<void> {
  await db.execute(sql`
    truncate table placement_results, seed_inboxes, warmup_sends, warmup_schedules, safety_stops, oauth_link_states, pool_members, pool_inboxes, inbox_analysis,
      dns_checks, blacklist_checks, placement_tests, reputation_scores, diagnostics,
      notifications, inboxes, users restart identity cascade
  `);
}

export async function closeDb(): Promise<void> {
  await (db as any).$client.end();
}

export async function createUser(plan = 'trial'): Promise<string> {
  const id = `user_${randomUUID()}`;
  await db.insert(users).values({ id, email: `${id}@owner.test`, plan });
  return id;
}

/** A unique address per call keeps GreenMail mailboxes isolated between tests. */
export function uniqueEmail(domainLabel: string): string {
  const tag = randomUUID().slice(0, 8);
  return `box-${tag}@${domainLabel}-${tag}.test`;
}

export async function createInbox(
  userId: string,
  overrides: Partial<typeof inboxes.$inferInsert> = {},
) {
  const email = overrides.email ?? uniqueEmail('warm');
  const [row] = await db
    .insert(inboxes)
    .values({
      userId,
      email,
      provider: 'custom',
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      smtpUser: email,
      smtpPass: encrypt(MAIL_PASSWORD),
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
      imapUser: email,
      imapPass: encrypt(MAIL_PASSWORD),
      status: 'active',
      poolConsentAt: new Date(),
      warmupSpeed: 'medium',
      warmupDay: 0,
      ...overrides,
    })
    .returning();
  return row;
}

/** Enrolls an inbox in the shared pool. */
export async function enroll(
  inbox: typeof inboxes.$inferSelect,
  overrides: Partial<typeof poolMembers.$inferInsert> = {},
) {
  const [row] = await db
    .insert(poolMembers)
    .values({
      inboxId: inbox.id,
      email: inbox.email,
      domain: inbox.email.split('@')[1].toLowerCase(),
      provider: inbox.provider,
      reputation: 50,
      active: true,
      quarantined: false,
      ...overrides,
    })
    .returning();
  return row;
}

export async function createPoolInbox(
  userId: string,
  overrides: Partial<typeof poolInboxes.$inferInsert> = {},
) {
  const email = overrides.email ?? uniqueEmail('pool');
  const [row] = await db
    .insert(poolInboxes)
    .values({
      userId,
      email,
      provider: 'custom',
      status: 'active',
      encryptedCredentials: {
        smtpHost: SMTP_HOST,
        smtpPort: SMTP_PORT,
        smtpUser: email,
        smtpPassword: encrypt(MAIL_PASSWORD),
        imapHost: IMAP_HOST,
        imapPort: IMAP_PORT,
        imapUser: email,
        imapPassword: encrypt(MAIL_PASSWORD),
      },
      ...overrides,
    })
    .returning();
  return row;
}

export async function planSend(
  sender: typeof inboxes.$inferSelect,
  receiver: { inboxId?: string; poolInboxId?: string },
  overrides: Partial<typeof warmupSends.$inferInsert> = {},
) {
  const [row] = await db
    .insert(warmupSends)
    .values({
      senderInboxId: sender.id,
      receiverInboxId: receiver.inboxId ?? null,
      receiverPoolInboxId: receiver.poolInboxId ?? null,
      messageId: `<${randomUUID()}@emailwarm.io>`,
      warmupDay: 1,
      scheduledAt: new Date(),
      status: 'planned',
      deliveryKey: `test:${randomUUID()}`,
      ...overrides,
    })
    .returning();
  return row;
}

export async function getSend(id: string) {
  const rows = await db
    .select()
    .from(warmupSends)
    .where(sql`${warmupSends.id} = ${id}`);
  return rows[0];
}

let jobCounter = 0;
export function fakeJob<T>(data: T, id?: string): Job<T> {
  return { id: id ?? `job-${++jobCounter}`, data } as unknown as Job<T>;
}

export function sendJobFor(row: typeof warmupSends.$inferSelect) {
  return fakeJob({
    sendId: row.id,
    senderInboxId: row.senderInboxId,
    partnerSource: (row.receiverPoolInboxId ? 'private' : 'shared') as 'private' | 'shared',
    partnerId: (row.receiverPoolInboxId ?? row.receiverInboxId)!,
    warmupDay: row.warmupDay,
    scheduledAt: row.scheduledAt.toISOString(),
  });
}

// ---- Independent mailbox inspection (does not go through the code under test) ----

export async function withMailbox<T>(
  email: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: email, pass: MAIL_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export interface SeenMessage {
  folder: string;
  flags: string[];
  messageId: string;
  inReplyTo?: string;
  from?: string;
  to?: string;
  headers: string;
}

/** Every copy of a message (by Message-ID) across all of a mailbox's folders. */
export async function findEverywhere(email: string, messageId: string): Promise<SeenMessage[]> {
  return withMailbox(email, async (client) => {
    const found: SeenMessage[] = [];
    for (const mailbox of await client.list()) {
      const lock = await client.getMailboxLock(mailbox.path);
      try {
        const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        for (const uid of uids || []) {
          const msg = await client.fetchOne(
            String(uid),
            { envelope: true, flags: true, headers: ['x-warmuphub', 'in-reply-to', 'references'] },
            { uid: true },
          );
          if (!msg) continue;
          found.push({
            folder: mailbox.path,
            flags: [...(msg.flags ?? [])],
            messageId: msg.envelope?.messageId ?? '',
            inReplyTo: msg.envelope?.inReplyTo,
            from: msg.envelope?.from?.[0]?.address,
            to: msg.envelope?.to?.[0]?.address,
            headers: msg.headers?.toString() ?? '',
          });
        }
      } finally {
        lock.release();
      }
    }
    return found;
  });
}

export async function countInFolder(email: string, folder: string): Promise<number> {
  return withMailbox(email, async (client) => {
    const paths = (await client.list()).map((m) => m.path);
    if (!paths.includes(folder)) return 0;
    const status = await client.status(folder, { messages: true });
    return status.messages ?? 0;
  });
}

/** Moves a delivered message into Junk, as a spam filter would have. */
export async function moveToJunk(email: string, messageId: string): Promise<void> {
  await withMailbox(email, async (client) => {
    const paths = (await client.list()).map((m) => m.path);
    if (!paths.includes('Junk')) await client.mailboxCreate('Junk');
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (!uids || uids.length === 0) throw new Error('message not in INBOX');
      await client.messageMove(String(uids[0]), 'Junk', { uid: true });
    } finally {
      lock.release();
    }
  });
}

/** Delivers a message straight to a mailbox, bypassing the code under test. */
export async function deliverRaw(opts: {
  from: string;
  to: string;
  messageId: string;
  subject?: string;
}): Promise<void> {
  const transport = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false });
  await transport.sendMail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject ?? 'Quick hello',
    text: 'Hope your week is going well.',
    messageId: opts.messageId,
  });
}

/** Delivers an arbitrary raw message (e.g. a bounce notice) to a mailbox. */
export async function deliverSource(to: string, from: string, raw: string): Promise<void> {
  const transport = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false });
  await transport.sendMail({ envelope: { from, to: [to] }, raw });
}

/** A delivery status notification about `messageId`, as a mail server would write it. */
export function bounceNotice(opts: {
  to: string;
  messageId: string;
  recipient?: string;
  action?: string;
  status?: string;
  from?: string;
}): string {
  const fields = [
    opts.recipient ? `Final-Recipient: rfc822; ${opts.recipient}` : null,
    `Action: ${opts.action ?? 'failed'}`,
    `Status: ${opts.status ?? '5.1.1'}`,
    'Diagnostic-Code: smtp; 550 5.1.1 No such user here',
  ].filter(Boolean);
  return [
    `From: Mail Delivery System <${opts.from ?? 'MAILER-DAEMON@mx.partner.test'}>`,
    `To: ${opts.to}`,
    'Subject: Undelivered Mail Returned to Sender',
    `Message-ID: <dsn-${randomUUID()}@mx.partner.test>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn"',
    '',
    '--dsn',
    'Content-Type: text/plain',
    '',
    'Your message could not be delivered.',
    '',
    '--dsn',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.partner.test',
    '',
    ...fields,
    '',
    '--dsn',
    'Content-Type: text/rfc822-headers',
    '',
    `Message-ID: ${opts.messageId}`,
    'Subject: Quick hello',
    '',
    '--dsn--',
    '',
  ].join('\r\n');
}
