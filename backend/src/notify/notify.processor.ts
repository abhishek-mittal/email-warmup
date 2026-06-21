import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import * as nodemailer from 'nodemailer';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { diagnostics, inboxes, users } from '../db/schema';
import {
  renderBlacklistHitEmail,
  renderDnsBrokenEmail,
  renderPaymentFailedEmail,
  renderPlanActivatedEmail,
  renderScoreDropEmail,
  renderTokenRevokedEmail,
  renderTrialExpiredEmail,
  renderWarmupCompleteEmail,
} from './email-templates';
import { formatSlackMessage, SlackAlertType } from './slack-formatter';

/**
 * NotifyProcessor — handles jobs on the `notify` queue.
 *
 * Job payload:
 *   { userId, inboxId?, type, channel: 'email' | 'slack', payload }
 *
 * Behaviors (see `notify.processor.spec.ts` for the full contract):
 *
 *   channel === 'email':
 *     1. Load the user (UnrecoverableError if missing).
 *     2. If the template needs an inbox, load the inbox (UnrecoverableError
 *        if missing). warmup_complete additionally requires a `graduation`
 *        diagnostics row to exist (race-condition guard).
 *     3. Render the template via the matching renderXxxEmail() and send via
 *        nodemailer using PLATFORM_SMTP_* env vars. SMTP errors propagate
 *        so BullMQ retries.
 *     4. After the email is sent, if `inboxId` is present AND the user's
 *        plan is growth/agency/enterprise AND a slackWebhookUrl is set,
 *        inline POST to that webhook with formatSlackMessage(...). The
 *        Slack fan-out only fires when the original channel was 'email'.
 *
 *   channel === 'slack':
 *     1. Load the user. If no slackWebhookUrl is set → UnrecoverableError
 *        (no plan-gate re-check; channel='slack' is opt-in by the caller).
 *     2. POST formatSlackMessage(...) to the webhook.
 */

type Channel = 'email' | 'slack';

type NotifyType =
  | 'dns_broken'
  | 'blacklist_hit'
  | 'score_drop'
  | 'token_revoked'
  | 'warmup_complete'
  | 'trial_expired'
  | 'plan_activated'
  | 'payment_failed';

interface NotifyJobData {
  userId: string;
  inboxId?: string;
  type: NotifyType;
  channel: Channel;
  payload: Record<string, any>;
}

/** Inbox-scoped types — they need the inbox row to render the email body. */
const INBOX_SCOPED_TYPES: ReadonlySet<NotifyType> = new Set<NotifyType>([
  'dns_broken',
  'blacklist_hit',
  'score_drop',
  'token_revoked',
  'warmup_complete',
]);

/** Slack fan-out types — the subset of NotifyType that formatSlackMessage accepts. */
const SLACK_COMPATIBLE_TYPES: ReadonlySet<NotifyType> = new Set<NotifyType>([
  'dns_broken',
  'blacklist_hit',
  'score_drop',
  'token_revoked',
  'warmup_complete',
]);

/** Plans that may receive the inline Slack fan-out (Growth+). */
const SLACK_ELIGIBLE_PLANS: ReadonlySet<string> = new Set<string>([
  'growth',
  'agency',
  'enterprise',
]);

type UserRow = typeof users.$inferSelect;
type InboxRow = typeof inboxes.$inferSelect;
type DiagnosticsRow = typeof diagnostics.$inferSelect;

@Injectable()
@Processor('notify')
export class NotifyProcessor extends WorkerHost {
  private readonly logger = new Logger(NotifyProcessor.name);

  constructor() {
    super();
  }

  async process(job: Job<NotifyJobData>): Promise<void> {
    const { userId, inboxId, type, channel, payload } = job.data;

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      throw new UnrecoverableError(`User not found: ${userId}`);
    }

    if (channel === 'email') {
      await this.handleEmail(user, inboxId, type, payload);
      return;
    }

    if (channel === 'slack') {
      await this.handleSlack(user, inboxId, type, payload);
      return;
    }

    throw new UnrecoverableError(`Unknown channel: ${String(channel)}`);
  }

  // ---------------------------------------------------------------------------
  // channel === 'email'
  // ---------------------------------------------------------------------------

  private async handleEmail(
    user: UserRow,
    inboxId: string | undefined,
    type: NotifyType,
    payload: Record<string, any>,
  ): Promise<void> {
    const needsInbox = INBOX_SCOPED_TYPES.has(type);
    let inbox: InboxRow | undefined;
    if (needsInbox) {
      if (!inboxId) {
        throw new UnrecoverableError(
          `Inbox-scoped notification '${type}' requires inboxId in job payload`,
        );
      }
      const [found] = await db
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.id, inboxId), eq(inboxes.userId, user.id)))
        .limit(1);
      if (!found) {
        throw new UnrecoverableError(`Inbox not found: ${inboxId}`);
      }
      inbox = found;
    }

    let recommendedDailySendVolume = 0;
    if (type === 'warmup_complete') {
      const [diag] = await db
        .select()
        .from(diagnostics)
        .where(and(eq(diagnostics.inboxId, inboxId!), eq(diagnostics.triggerType, 'graduation')))
        .orderBy(desc(diagnostics.createdAt))
        .limit(1);
      if (!diag) {
        throw new UnrecoverableError(
          `Graduation diagnostics row missing for inbox ${inboxId} (warmup_complete race-condition guard)`,
        );
      }
      const report = (diag.readinessReport ?? {}) as { recommendedDailySendVolume?: number };
      recommendedDailySendVolume = report.recommendedDailySendVolume ?? 0;
    }

    const rendered = this.renderEmail(type, {
      user,
      inbox,
      payload,
      recommendedDailySendVolume,
    });

    const transport = nodemailer.createTransport({
      host: process.env.PLATFORM_SMTP_HOST!,
      port: Number(process.env.PLATFORM_SMTP_PORT!),
      auth: {
        user: process.env.PLATFORM_SMTP_USER!,
        pass: process.env.PLATFORM_SMTP_PASS!,
      },
    });

    // Intentionally do NOT catch — SMTP failures must propagate so BullMQ retries.
    await transport.sendMail({
      from: process.env.PLATFORM_FROM_EMAIL!,
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
    });

    this.logger.log(`Sent ${type} email to ${user.email}`);

    // Inline Slack fan-out — only when an inbox is in play AND the user is on
    // a plan that opted into Slack AND they've set a webhook URL. The Slack
    // call happens AFTER the email send.
    if (inboxId && inbox && this.shouldFanOutToSlack(user, type)) {
      await this.postToSlack(user, inbox, type, payload);
    }
  }

  // ---------------------------------------------------------------------------
  // channel === 'slack'
  // ---------------------------------------------------------------------------

  private async handleSlack(
    user: UserRow,
    inboxId: string | undefined,
    type: NotifyType,
    payload: Record<string, any>,
  ): Promise<void> {
    if (!user.slackWebhookUrl) {
      throw new UnrecoverableError(
        `Cannot deliver slack-channel notification: user ${user.id} has no slackWebhookUrl`,
      );
    }

    if (!SLACK_COMPATIBLE_TYPES.has(type) || !inboxId) {
      throw new UnrecoverableError(
        `Slack-channel notification requires an inbox-scoped type and inboxId (got type=${type})`,
      );
    }

    const [inbox] = await db
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.id, inboxId), eq(inboxes.userId, user.id)))
      .limit(1);
    if (!inbox) {
      throw new UnrecoverableError(`Inbox not found: ${inboxId}`);
    }

    const message = formatSlackMessage({
      type: type as SlackAlertType,
      inboxEmail: inbox.email,
      inboxId: inbox.id,
      appUrl: process.env.APP_URL ?? '',
      payload,
    });

    const response = await fetch(user.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      // Slack delivery failure — let BullMQ retry.
      throw new Error(
        `Slack webhook POST failed: ${response.status} ${response.statusText}`,
      );
    }

    this.logger.log(`Sent ${type} slack notification to user ${user.id}`);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private shouldFanOutToSlack(user: UserRow, type: NotifyType): boolean {
    if (!SLACK_COMPATIBLE_TYPES.has(type)) return false;
    if (!user.slackWebhookUrl) return false;
    if (!SLACK_ELIGIBLE_PLANS.has(user.plan ?? '')) return false;
    return true;
  }

  private async postToSlack(
    user: UserRow,
    inbox: InboxRow,
    type: NotifyType,
    payload: Record<string, any>,
  ): Promise<void> {
    const message = formatSlackMessage({
      type: type as SlackAlertType,
      inboxEmail: inbox.email,
      inboxId: inbox.id,
      appUrl: process.env.APP_URL ?? '',
      payload,
    });

    const response = await fetch(user.slackWebhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      // Slack failure should not undo a successful email — log and move on.
      this.logger.warn(
        `Slack fan-out webhook POST returned ${response.status} for user ${user.id} (type=${type})`,
      );
      return;
    }

    this.logger.log(`Slack fan-out delivered to user ${user.id} (type=${type})`);
  }

  private renderEmail(
    type: NotifyType,
    ctx: {
      user: UserRow;
      inbox?: InboxRow;
      payload: Record<string, any>;
      recommendedDailySendVolume: number;
    },
  ): { subject: string; html: string } {
    const appUrl = process.env.APP_URL ?? '';
    const { user, inbox, payload, recommendedDailySendVolume } = ctx;

    switch (type) {
      case 'dns_broken':
        return renderDnsBrokenEmail({
          inboxEmail: inbox!.email,
          issueCodes: payload.issueCodes ?? [],
        });
      case 'blacklist_hit':
        return renderBlacklistHitEmail({
          inboxEmail: inbox!.email,
          listed: payload.listed ?? [],
        });
      case 'score_drop':
        return renderScoreDropEmail({
          inboxEmail: inbox!.email,
          prev: payload.prev ?? 0,
          current: payload.current ?? 0,
          delta: payload.delta ?? 0,
        });
      case 'token_revoked':
        return renderTokenRevokedEmail({ inboxEmail: inbox!.email });
      case 'warmup_complete':
        return renderWarmupCompleteEmail({
          inboxEmail: inbox!.email,
          warmupDay: payload.warmupDay ?? 0,
          recommendedDailySendVolume,
        });
      case 'trial_expired':
        return renderTrialExpiredEmail({ appUrl });
      case 'plan_activated':
        return renderPlanActivatedEmail({ plan: user.plan ?? 'starter' });
      case 'payment_failed':
        return renderPaymentFailedEmail({ appUrl });
      default: {
        const exhaustive: never = type;
        throw new UnrecoverableError(`Unknown notification type: ${String(exhaustive)}`);
      }
    }
  }
}
