import {
  BadRequestException,
  Controller,
  Headers,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { Public } from '@/auth/public.decorator';
import { db } from '../db';
import { stripeEvents, users } from '../db/schema';
import { BillingService } from './billing.service';

/**
 * Stripe webhook entrypoint. Must be @Public() — Stripe does not present a
 * Clerk JWT; it presents a Stripe-Signature header instead. The raw body is
 * required for signature verification, which is configured in main.ts ahead
 * of the global bodyParser.json().
 */
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private readonly billingService: BillingService) {}

  private get stripe(): Stripe {
    return new Stripe(process.env.STRIPE_SECRET_KEY as string);
  }

  @Public()
  @Post('stripe')
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new BadRequestException('Stripe webhook secret not configured');
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw body for signature verification');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(req.rawBody, signature, secret);
    } catch (err: any) {
      // Per T016 acceptance: invalid signature must return 400, not 500.
      this.logger.warn(`Invalid Stripe webhook signature: ${err?.message ?? err}`);
      throw new BadRequestException('Invalid signature');
    }

    // Idempotency check: if we've already processed this event id, return
    // early without re-running handlers. The unique-violation catch below
    // covers the race where two webhooks land simultaneously.
    const existing = await db
      .select({ id: stripeEvents.id })
      .from(stripeEvents)
      .where(eq(stripeEvents.id, event.id))
      .limit(1);
    if (existing.length > 0) {
      return { received: true, duplicate: true };
    }

    await this.dispatch(event);

    try {
      await db.insert(stripeEvents).values({ id: event.id });
    } catch (err: any) {
      // Unique-violation race: another worker inserted the same id between
      // our select and insert. That's fine — idempotency still holds.
      const code = err?.code ?? err?.cause?.code;
      if (code !== '23505') {
        throw err;
      }
    }

    return { received: true };
  }

  /**
   * Routes a verified Stripe event to the matching BillingService method.
   * For subscription.updated / subscription.deleted the userId is expected
   * to live on the subscription object's metadata (we wrote it there at
   * checkout time). As a fallback we look the user up by stripeCustomerId.
   */
  private async dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan;
        const subId = (session.subscription as string) ?? '';
        const customerId = (session.customer as string) ?? '';
        if (!userId || !plan || !subId || !customerId) {
          this.logger.warn(
            `checkout.session.completed missing required fields (userId=${userId}, plan=${plan}, subId=${subId}, customerId=${customerId})`,
          );
          return;
        }
        await this.billingService.activatePlan(userId, plan, subId, customerId);
        return;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const userId =
          sub.metadata?.userId ?? (await this.userIdForCustomer(sub.customer as string));
        if (!userId) {
          this.logger.warn(`customer.subscription.updated missing userId for sub ${sub.id}`);
          return;
        }
        const priceId = sub.items.data[0]?.price?.id;
        if (!priceId) {
          this.logger.warn(`customer.subscription.updated missing price id for sub ${sub.id}`);
          return;
        }
        const plan = this.billingService.planFromPriceId(priceId);
        await this.billingService.updatePlan(userId, plan);
        return;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId =
          sub.metadata?.userId ?? (await this.userIdForCustomer(sub.customer as string));
        if (!userId) {
          this.logger.warn(`customer.subscription.deleted missing userId for sub ${sub.id}`);
          return;
        }
        await this.billingService.downgradePlan(userId);
        return;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        if (!customerId) {
          this.logger.warn('invoice.payment_failed missing customer id');
          return;
        }
        await this.billingService.handlePaymentFailure(customerId);
        return;
      }

      default:
        // Acknowledge unhandled events so Stripe stops retrying them.
        return;
    }
  }

  private async userIdForCustomer(customerId: string): Promise<string | null> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.stripeCustomerId, customerId))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}
