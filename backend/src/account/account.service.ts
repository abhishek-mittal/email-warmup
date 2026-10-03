import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  diagnostics,
  dnsChecks,
  inboxAnalysis,
  inboxes,
  notifications,
  oauthLinkStates,
  poolInboxes,
  poolMembers,
  users,
  warmupSends,
} from '../db/schema';
import { ImapClientService } from '../inbox/imap/imap-client.service';
import { WarmupService } from '../warmup/warmup.service';

const EXPORT_SEND_LIMIT = 5000;

/** An address that identifies nobody, on a domain that can never receive mail. */
const anonymousAddress = () => `deleted-${randomUUID()}@deleted.invalid`;

/**
 * Leaving the product (MR-21): disconnect a mailbox, export an account's
 * data, delete an account.
 *
 * Deletion anonymizes rather than erases the send ledger. Every send row is
 * also part of the partner's history — their statistics, bounce rate and
 * pairing limits are computed from it — so removing rows would corrupt
 * another customer's data. What is removed is everything that identifies the
 * departing customer: credentials, addresses, hosts, subjects, DNS record
 * text, diagnostics, notifications, and the account itself.
 */
@Injectable()
export class AccountService {
  constructor(
    @InjectPinoLogger(AccountService.name)
    private readonly logger: PinoLogger,
    private readonly warmupService: WarmupService,
    private readonly imapClientService: ImapClientService,
  ) {}

  /**
   * Stops a mailbox for good and erases its stored credentials. The inbox
   * row and its history stay (shown as disconnected) and no longer use a
   * plan slot. Reconnecting the same Gmail/Outlook mailbox revives it.
   */
  async disconnectInbox(userId: string, inboxId: string) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) throw new NotFoundException();
    await this.stopAndEraseCredentials(inboxId);
    this.logger.info({ userId, inboxId }, 'inbox disconnected');
    return { id: inboxId, status: 'disconnected' };
  }

  private async stopAndEraseCredentials(inboxId: string): Promise<void> {
    // Releases reservations and drains queued send/receive jobs.
    await this.warmupService.pauseInbox(inboxId, 'disconnected');
    await this.imapClientService.close(inboxId).catch(() => undefined);
    await db.update(poolMembers).set({ active: false }).where(eq(poolMembers.inboxId, inboxId));
    await db
      .update(inboxes)
      .set({
        status: 'disconnected',
        statusReason: 'disconnected',
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiry: null,
        oauthClientSecret: null,
        smtpPass: null,
        imapPass: null,
        poolConsentAt: null,
      })
      .where(eq(inboxes.id, inboxId));
  }

  /** Everything held about the account, without credentials. */
  async exportData(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    const myInboxes = await db.select().from(inboxes).where(eq(inboxes.userId, userId));
    const myPool = await db.select().from(poolInboxes).where(eq(poolInboxes.userId, userId));
    const inboxIds = myInboxes.map((row) => row.id);

    const sends = inboxIds.length
      ? await db
          .select({
            id: warmupSends.id,
            senderInboxId: warmupSends.senderInboxId,
            status: warmupSends.status,
            subject: warmupSends.subject,
            scheduledAt: warmupSends.scheduledAt,
            sentAt: warmupSends.sentAt,
            openedAt: warmupSends.openedAt,
            repliedAt: warmupSends.repliedAt,
            landedInSpam: warmupSends.landedInSpam,
            bounceType: warmupSends.bounceType,
          })
          .from(warmupSends)
          .where(inArray(warmupSends.senderInboxId, inboxIds))
          .orderBy(desc(warmupSends.createdAt))
          .limit(EXPORT_SEND_LIMIT)
      : [];

    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        trialEndsAt: user.trialEndsAt,
        createdAt: user.createdAt,
      },
      inboxes: myInboxes.map((row) => ({
        id: row.id,
        email: row.email,
        provider: row.provider,
        status: row.status,
        warmupDay: row.warmupDay,
        warmupSpeed: row.warmupSpeed,
        smtpHost: row.smtpHost,
        imapHost: row.imapHost,
        poolConsentAt: row.poolConsentAt,
        graduatedAt: row.graduatedAt,
        createdAt: row.createdAt,
      })),
      poolInboxes: myPool.map((row) => ({
        id: row.id,
        email: row.email,
        provider: row.provider,
        status: row.status,
        createdAt: row.createdAt,
      })),
      warmupSends: sends,
      warmupSendsTruncated: sends.length === EXPORT_SEND_LIMIT,
    };
  }

  /**
   * Deletes the account. `confirmEmail` must match the account's address.
   * Not reversible.
   */
  async deleteAccount(userId: string, confirmEmail: unknown) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    if (
      typeof confirmEmail !== 'string' ||
      confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new BadRequestException('Type your account email address to confirm deletion');
    }

    const myInboxes = await db.select().from(inboxes).where(eq(inboxes.userId, userId));
    const myPool = await db.select().from(poolInboxes).where(eq(poolInboxes.userId, userId));
    const inboxIds = myInboxes.map((row) => row.id);
    const poolIds = myPool.map((row) => row.id);

    // 1. Stop all mail activity and drop credentials. Queue work happens
    //    outside the transaction; each step is safe to repeat.
    for (const inbox of myInboxes) {
      await this.stopAndEraseCredentials(inbox.id);
    }
    for (const poolInbox of myPool) {
      await this.imapClientService.close(poolInbox.id).catch(() => undefined);
    }

    // 2. Remove or anonymize everything that identifies the customer.
    await db.transaction(async (tx) => {
      if (poolIds.length) {
        // Reserved sends to these pool inboxes must not go out.
        await tx
          .update(warmupSends)
          .set({ status: 'canceled', failureReason: 'receiver account deleted' })
          .where(
            sql`${inArray(warmupSends.receiverPoolInboxId, poolIds)} and ${warmupSends.status} = 'planned'`,
          );
        for (const id of poolIds) {
          await tx
            .update(poolInboxes)
            .set({
              status: 'removed',
              email: anonymousAddress(),
              displayName: null,
              encryptedCredentials: {},
              errorMessage: null,
              updatedAt: new Date(),
            })
            .where(eq(poolInboxes.id, id));
        }
        await tx.delete(inboxAnalysis).where(inArray(inboxAnalysis.poolInboxId, poolIds));
      }

      if (inboxIds.length) {
        await tx.delete(diagnostics).where(inArray(diagnostics.inboxId, inboxIds));
        await tx.delete(dnsChecks).where(inArray(dnsChecks.inboxId, inboxIds));
        await tx.delete(inboxAnalysis).where(inArray(inboxAnalysis.inboxId, inboxIds));
        for (const id of inboxIds) {
          const address = anonymousAddress();
          await tx
            .update(inboxes)
            .set({
              email: address,
              smtpHost: null,
              smtpPort: null,
              smtpUser: null,
              imapHost: null,
              imapPort: null,
              imapUser: null,
              oauthClientId: null,
              dkimSelector: null,
              sendingIp: null,
            })
            .where(eq(inboxes.id, id));
          await tx
            .update(poolMembers)
            .set({ email: address, domain: 'deleted.invalid', industry: null, active: false })
            .where(eq(poolMembers.inboxId, id));
        }
      }

      // Send rows stay for the partners' sake; their subjects go.
      const involved = [
        inboxIds.length ? inArray(warmupSends.senderInboxId, inboxIds) : undefined,
        inboxIds.length ? inArray(warmupSends.receiverInboxId, inboxIds) : undefined,
        poolIds.length ? inArray(warmupSends.receiverPoolInboxId, poolIds) : undefined,
      ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause));
      if (involved.length) {
        await tx
          .update(warmupSends)
          .set({ subject: null, bounceDetail: null, failureReason: null, smtpResponse: null })
          .where(or(...involved));
      }

      await tx.delete(notifications).where(eq(notifications.userId, userId));
      await tx.delete(oauthLinkStates).where(eq(oauthLinkStates.userId, userId));
      await tx
        .update(users)
        .set({
          email: anonymousAddress(),
          plan: 'deleted',
          trialEndsAt: null,
          stripeCustomerId: null,
          stripeSubId: null,
          slackWebhookUrl: null,
        })
        .where(eq(users.id, userId));

      // 3. The sign-in identity (better-auth tables, same database). Removing
      //    the sessions signs the person out everywhere at once.
      for (const table of ['session', 'account'] as const) {
        const exists = await tx.execute(sql`select to_regclass(${'public.' + table}) as t`);
        if ((exists.rows[0] as { t: string | null })?.t) {
          await tx.execute(sql`delete from ${sql.identifier(table)} where "userId" = ${userId}`);
        }
      }
      const userTable = await tx.execute(sql`select to_regclass('public.user') as t`);
      if ((userTable.rows[0] as { t: string | null })?.t) {
        await tx.execute(sql`delete from "user" where id = ${userId}`);
      }
    });

    this.logger.info(
      { userId, inboxes: inboxIds.length, poolInboxes: poolIds.length },
      'account deleted',
    );
    return { deleted: true };
  }
}
