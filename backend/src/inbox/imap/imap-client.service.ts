import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ImapFlow } from 'imapflow';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes, poolInboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { MailCredentialService } from '../oauth/mail-credential.service';
import { assertPort, resolvePublicHost } from '../../common/egress-policy';
import {
  MAIL_TIMEOUTS,
  imapTlsOptions,
  isOAuthProvider,
  providerEndpoints,
} from '../provider-config';

const IMAP_TIMEOUTS = {
  connectionTimeout: MAIL_TIMEOUTS.connection,
  greetingTimeout: MAIL_TIMEOUTS.greeting,
  socketTimeout: MAIL_TIMEOUTS.socket,
};

/**
 * Error thrown when a caller asks for an IMAP connection on an inbox that
 * has no IMAP configured (e.g. a custom-SMTP inbox where the user
 * didn't tick the "also use IMAP" box at connect time). Warmup/placement
 * code should catch this and treat it as "this inbox can't receive —
 * skip" rather than as a hard failure.
 */
export class ImapNotConfiguredError extends Error {
  constructor(id: string) {
    super(`IMAP not configured for ${id}`);
    this.name = 'ImapNotConfiguredError';
  }
}

// Pool-inbox connections are keyed with this prefix in the same pool map as
// regular inboxes. IDs are random UUIDv4s from separate tables so a
// collision is not realistically possible, but the explicit prefix makes
// intent unambiguous to future readers.
const POOL_INBOX_KEY_PREFIX = 'pool:';

@Injectable()
export class ImapClientService implements OnModuleDestroy {
  private pool = new Map<string, ImapFlow>();
  // Tail of the per-mailbox work queue; see withInbox/withPoolInbox.
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    @InjectPinoLogger(ImapClientService.name)
    private readonly logger: PinoLogger,
    private readonly credentials: MailCredentialService,
  ) {}

  /**
   * Runs `fn` with the inbox's pooled connection, one caller at a time per
   * mailbox. An IMAP connection has a single selected mailbox, so two jobs
   * interleaving on the same connection would search/flag/move each other's
   * messages. Callers must do all their IMAP work inside `fn`.
   */
  async withInbox<T>(inboxId: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.serialize(inboxId, async () => fn(await this.getConnection(inboxId)));
  }

  /** Same as withInbox, for a private-pool inbox. */
  async withPoolInbox<T>(poolInboxId: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.serialize(POOL_INBOX_KEY_PREFIX + poolInboxId, async () =>
      fn(await this.getPoolInboxConnection(poolInboxId)),
    );
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  async onModuleDestroy(): Promise<void> {
    const clients = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(clients.map((client) => client.logout().catch(() => undefined)));
  }

  async getConnection(inboxId: string): Promise<ImapFlow> {
    const existing = this.pool.get(inboxId);
    if (existing?.usable) {
      this.logger.debug({ inboxId }, 'IMAP connection reused from pool');
      return existing;
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    let host: string;
    let port: number;
    let servername: string | undefined;
    let auth: { user: string; pass?: string; accessToken?: string };

    if (isOAuthProvider(inbox.provider)) {
      // OAuth mailboxes always have IMAP; older rows (interactive Gmail,
      // batch imports) never stored a host/port, so fall back to the provider's.
      const endpoint = providerEndpoints(inbox.provider).imap;
      host = inbox.imapHost || endpoint.host;
      port = inbox.imapPort || endpoint.port;
      auth = {
        user: inbox.email,
        accessToken: await this.credentials.getInboxAccessToken(inboxId),
      };
    } else {
      // No IMAP creds on this row at all — surface a typed error so the
      // warmup/placement consumers can no-op instead of throwing.
      if (!inbox.imapHost || !inbox.imapPort || !inbox.imapUser || !inbox.imapPass) {
        this.logger.warn({ inboxId }, 'IMAP not configured — skipping receive action');
        throw new ImapNotConfiguredError(inboxId);
      }
      // Customer-supplied host: connect to the address that passed the egress
      // policy, keeping the name only for TLS.
      const target = await resolvePublicHost(inbox.imapHost);
      host = target.address;
      servername = target.servername;
      port = assertPort(inbox.imapPort);
      auth = { user: inbox.imapUser, pass: decrypt(inbox.imapPass) };
    }

    this.logger.debug(
      { inboxId, imapHost: host, imapPort: port, provider: inbox.provider },
      'opening new IMAP connection',
    );

    const client = new ImapFlow({
      host,
      port,
      ...(servername ? { servername } : {}),
      ...imapTlsOptions(port),
      ...IMAP_TIMEOUTS,
      auth,
      // Enable the ImapFlow protocol logger only at debug level — it's
      // extremely chatty and only useful when actively debugging an IMAP
      // issue. Default (info) keeps the terminal clean.
      logger: process.env.LOG_LEVEL === 'debug' ? undefined : false,
    } as ConstructorParameters<typeof ImapFlow>[0]);

    // Attach a quiet 'error' listener BEFORE we hand the client out.
    // imapflow emits 'error' on its ImapFlow instance when the underlying
    // socket drops mid-conversation (ECONNRESET, idle timeout, server
    // shutdown, etc.). Without a listener, Node escalates this to an
    // uncaughtException and CRASHES the entire NestJS process — which
    // is exactly what happened in prod on 2026-06-24. We:
    //  1. Log the error so we know the connection died.
    //  2. Evict it from the pool so the next getConnection() rebuilds
    //     a fresh socket instead of handing out a dead one.
    // The actual IMAP command that triggered the error has already
    // failed (its promise rejected with the same error) — there is no
    // in-flight call to "recover" here.
    client.on('error', (err: unknown) => {
      const e = err as { code?: string; message?: string };
      this.logger.warn(
        {
          inboxId,
          imapHost: host,
          imapPort: port,
          err: e?.message,
          errCode: e?.code,
        },
        'IMAP socket error — evicting from pool',
      );
      if (this.pool.get(inboxId) === client) {
        this.pool.delete(inboxId);
      }
    });

    try {
      await client.connect();
    } catch (err: any) {
      this.logger.error(
        {
          inboxId,
          imapHost: host,
          imapPort: port,
          provider: inbox.provider,
          err: err?.message,
          errCode: err?.code,
        },
        'IMAP connect failed',
      );
      throw err;
    }
    this.pool.set(inboxId, client);
    this.logger.info({ inboxId, provider: inbox.provider }, 'IMAP connection established');
    return client;
  }

  /**
   * Pool-inbox-aware connection. Loads `pool_inboxes`, parses
   * `encrypted_credentials` per the contract documented in T022, and
   * branches on `provider`:
   *  - 'custom': build ImapFlow directly from the decrypted creds.
   *  - 'gmail'/'outlook': mint a fresh access token via the relevant OAuth
   *    service's refreshToken() (no caching — pool inboxes have no column
   *    to cache an access token in, and this is a low-volume path).
   */
  async getPoolInboxConnection(poolInboxId: string): Promise<ImapFlow> {
    const key = POOL_INBOX_KEY_PREFIX + poolInboxId;
    const existing = this.pool.get(key);
    if (existing?.usable) {
      this.logger.debug({ poolInboxId }, 'IMAP connection reused from pool (pool inbox)');
      return existing;
    }

    const rows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, poolInboxId))
      .limit(1);
    const poolInbox = rows[0];
    if (!poolInbox) throw new Error('Pool inbox not found');

    const creds = (poolInbox.encryptedCredentials ?? {}) as Record<string, unknown>;

    let client: ImapFlow;
    if (poolInbox.provider === 'custom') {
      const imapHost = creds.imapHost as string | undefined;
      const imapPort = Number(creds.imapPort) || undefined;
      const imapUser = creds.imapUser as string | undefined;
      const imapPassword = creds.imapPassword as string | undefined;
      if (!imapHost || !imapPort || !imapUser || !imapPassword) {
        this.logger.warn({ poolInboxId }, 'IMAP not configured — skipping receive action');
        throw new ImapNotConfiguredError(poolInboxId);
      }

      this.logger.debug(
        { poolInboxId, imapHost, imapPort, provider: 'custom' },
        'opening new IMAP connection (pool inbox)',
      );
      const target = await resolvePublicHost(imapHost);
      assertPort(imapPort);
      client = new ImapFlow({
        host: target.address,
        port: imapPort,
        ...(target.servername ? { servername: target.servername } : {}),
        ...imapTlsOptions(imapPort),
        ...IMAP_TIMEOUTS,
        auth: { user: imapUser, pass: decrypt(imapPassword) },
        logger: process.env.LOG_LEVEL === 'debug' ? undefined : false,
      } as ConstructorParameters<typeof ImapFlow>[0]);
    } else if (isOAuthProvider(poolInbox.provider)) {
      if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
        this.logger.warn({ poolInboxId }, 'IMAP not configured — skipping receive action');
        throw new ImapNotConfiguredError(poolInboxId);
      }
      const endpoint = providerEndpoints(poolInbox.provider).imap;
      const accessToken = await this.credentials.getPoolInboxAccessToken(poolInboxId);

      this.logger.debug(
        {
          poolInboxId,
          imapHost: endpoint.host,
          imapPort: endpoint.port,
          provider: poolInbox.provider,
        },
        'opening new IMAP connection (pool inbox)',
      );
      client = new ImapFlow({
        host: endpoint.host,
        port: endpoint.port,
        ...imapTlsOptions(endpoint.port),
        ...IMAP_TIMEOUTS,
        auth: { user: poolInbox.email, accessToken },
        logger: process.env.LOG_LEVEL === 'debug' ? undefined : false,
      } as ConstructorParameters<typeof ImapFlow>[0]);
    } else {
      this.logger.warn({ poolInboxId }, 'IMAP not configured — skipping receive action');
      throw new ImapNotConfiguredError(poolInboxId);
    }

    // Same 'error' listener pattern as getConnection() above — see the
    // comment there for the rationale (this exact path was the source of
    // the 2026-06-24 ECONNRESET crash that took the whole backend down).
    // Pool key uses the 'pool:' prefix; the eviction check below uses
    // the same key so a dead pool-inbox connection doesn't get handed
    // back out as "usable".
    const hostForLog =
      poolInbox.provider === 'gmail'
        ? 'imap.gmail.com'
        : poolInbox.provider === 'outlook'
          ? 'outlook.office365.com'
          : ((creds.imapHost as string | undefined) ?? 'unknown');
    client.on('error', (err: unknown) => {
      const e = err as { code?: string; message?: string };
      this.logger.warn(
        {
          poolInboxId,
          imapHost: hostForLog,
          provider: poolInbox.provider,
          err: e?.message,
          errCode: e?.code,
        },
        'IMAP socket error (pool inbox) — evicting from pool',
      );
      if (this.pool.get(key) === client) {
        this.pool.delete(key);
      }
    });

    try {
      await client.connect();
    } catch (err: any) {
      this.logger.error(
        {
          poolInboxId,
          provider: poolInbox.provider,
          err: err?.message,
          errCode: err?.code,
        },
        'IMAP connect failed (pool inbox)',
      );
      throw err;
    }
    this.pool.set(key, client);
    this.logger.info(
      { poolInboxId, provider: poolInbox.provider },
      'IMAP connection established (pool inbox)',
    );
    return client;
  }

  async close(id: string): Promise<void> {
    const directKey = this.pool.has(id) ? id : undefined;
    const poolKey = this.pool.has(POOL_INBOX_KEY_PREFIX + id)
      ? POOL_INBOX_KEY_PREFIX + id
      : undefined;
    const key = directKey ?? poolKey;
    if (!key) return;

    const client = this.pool.get(key);
    if (client) {
      this.logger.debug({ id, key }, 'IMAP connection closed');
      await client.logout();
      this.pool.delete(key);
    }
  }
}
