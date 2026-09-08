import { BadRequestException, Injectable, ForbiddenException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { eq, count } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../db';
import { users, inboxes } from '../db/schema';
import { QueueService } from '../queue/queue.service';

export const PLAN_LIMITS: Record<
  string,
  { inboxes: number; placementTests: number; diagnosticsAi: boolean; slackAlerts: boolean }
> = {
  free: { inboxes: 0, placementTests: 0, diagnosticsAi: false, slackAlerts: false },
  trial: { inboxes: 3, placementTests: 1, diagnosticsAi: false, slackAlerts: false },
  starter: { inboxes: 3, placementTests: 1, diagnosticsAi: false, slackAlerts: false },
  growth: { inboxes: 20, placementTests: 5, diagnosticsAi: true, slackAlerts: true },
  agency: { inboxes: 100, placementTests: -1, diagnosticsAi: true, slackAlerts: true },
  enterprise: { inboxes: -1, placementTests: -1, diagnosticsAi: true, slackAlerts: true },
};

// Plans purchasable via Stripe Checkout. Enterprise is handled manually — no
// Stripe price exists for it (see T016 context addendum #9).
const CHECKOUT_PLANS = ['starter', 'growth', 'agency'] as const;
type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

@Injectable()
export class BillingService {
  constructor(
    @InjectPinoLogger(BillingService.name)
    private readonly logger: PinoLogger,
    private readonly queueService: QueueService,
  ) {}

  private get stripe(): Stripe {
    return new Stripe(process.env.STRIPE_SECRET_KEY as string);
  }

  private priceIdForPlan(plan: CheckoutPlan): string {
    switch (plan) {
      case 'starter':
        return process.env.STRIPE_PRICE_STARTER as string;
      case 'growth':
        return process.env.STRIPE_PRICE_GROWTH as string;
      case 'agency':
        return process.env.STRIPE_PRICE_AGENCY as string;
    }
  }

  /** Maps a Stripe price id (from env) back to its plan name. */
  planFromPriceId(priceId: string): CheckoutPlan {
    const match = CHECKOUT_PLANS.find((plan) => this.priceIdForPlan(plan) === priceId);
    if (!match) {
      throw new BadRequestException(`Unrecognized Stripe price id: ${priceId}`);
    }
    return match;
  }

  async assertPlan(userId: string, allowedPlans: string[]): Promise<void> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || !allowedPlans.includes(user.plan)) {
      this.logger.warn({ userId, allowedPlans, currentPlan: user?.plan }, 'assertPlan rejected');
      throw new ForbiddenException(`This feature requires plan: ${allowedPlans.join(' or ')}`);
    }
  }

  async assertInboxLimit(userId: string): Promise<void> {
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];
    if (!user) {
      this.logger.warn({ userId }, 'assertInboxLimit rejected: User not found');
      throw new ForbiddenException('User not found');
    }
    const limit = PLAN_LIMITS[user.plan]?.inboxes ?? 0;
    // -1 is the "unlimited" sentinel (enterprise plan) — never count-check it,
    // otherwise `count >= -1` is always true and unlimited plans get rejected
    // on their very first inbox.
    if (limit === -1) {
      return;
    }
    const [result] = await db
      .select({ count: count() })
      .from(inboxes)
      .where(eq(inboxes.userId, userId));
    if (result.count >= limit) {
      this.logger.warn(
        { userId, plan: user.plan, inboxesUsed: result.count, inboxLimit: limit },
        'assertInboxLimit rejected: inbox limit reached',
      );
      throw new ForbiddenException(`Inbox limit reached for ${user.plan} plan (${limit} inboxes)`);
    }
  }

  /** Creates a Stripe Checkout session in subscription mode. Enterprise is rejected — handled manually. */
  async createCheckoutSession(userId: string, plan: string): Promise<{ url: string }> {
    if (!CHECKOUT_PLANS.includes(plan as CheckoutPlan)) {
      throw new BadRequestException(`Plan '${plan}' is not purchasable via Stripe Checkout`);
    }

    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: user.stripeCustomerId ?? undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      line_items: [{ price: this.priceIdForPlan(plan as CheckoutPlan), quantity: 1 }],
      success_url: `${process.env.APP_URL}/dashboard?checkout=success`,
      cancel_url: `${process.env.APP_URL}/billing?checkout=cancelled`,
      metadata: { userId, plan },
    });

    return { url: session.url as string };
  }

  /** Creates a Stripe Billing Portal session for self-serve plan management. */
  async createPortalSession(userId: string): Promise<{ url: string }> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user?.stripeCustomerId) {
      throw new BadRequestException('No active subscription');
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.APP_URL}/billing`,
    });

    return { url: session.url };
  }

  /** Called by the webhook on checkout.session.completed. */
  async activatePlan(
    userId: string,
    plan: string,
    subId: string,
    customerId: string,
  ): Promise<void> {
    await db
      .update(users)
      .set({
        plan,
        stripeSubId: subId,
        stripeCustomerId: customerId,
        trialEndsAt: null,
      })
      .where(eq(users.id, userId));

    await this.queueService.add('notify', {
      userId,
      type: 'plan_activated',
      channel: 'email',
      payload: { plan },
    });
  }

  /** Called by the webhook on customer.subscription.updated. */
  async updatePlan(userId: string, plan: string): Promise<void> {
    await db.update(users).set({ plan }).where(eq(users.id, userId));
  }

  /**
   * Called by the webhook on customer.subscription.deleted. Pauses every
   * inbox the user owns BEFORE downgrading the plan (non-negotiable #5 /
   * addendum #7) — sequential awaits, not Promise.all. No notification type
   * is spec'd for this path (only activatePlan/handlePaymentFailure/
   * expireTrials have one — addendum #6), so none is sent here.
   */
  async downgradePlan(userId: string): Promise<void> {
    await this.pauseAllInboxes(userId);
    await db.update(users).set({ plan: 'free' }).where(eq(users.id, userId));
  }

  /** Called by the webhook on invoice.payment_failed. */
  async handlePaymentFailure(customerId: string): Promise<void> {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, customerId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      return;
    }

    await this.queueService.add('notify', {
      userId: user.id,
      type: 'payment_failed',
      channel: 'email',
      payload: {},
    });
  }

  /**
   * Pauses every inbox a user owns, duplicating WarmupService.pauseInbox's
   * direct DB/queue work rather than injecting WarmupService — importing
   * WarmupModule here would create a circular module dependency
   * (BillingModule -> WarmupModule -> InboxModule -> BillingModule). See
   * T016 context addendum #5.
   */
  private async pauseAllInboxes(userId: string): Promise<void> {
    const userInboxes = await db.select().from(inboxes).where(eq(inboxes.userId, userId));
    for (const inbox of userInboxes) {
      await db.update(inboxes).set({ status: 'paused' }).where(eq(inboxes.id, inbox.id));
      await this.queueService.removeJobsForSender('warmup-send', inbox.id);
      await this.queueService.removeJobsForReceiver('warmup-receive', inbox.id);
    }
  }
}
