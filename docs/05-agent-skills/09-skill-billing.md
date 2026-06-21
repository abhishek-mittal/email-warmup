# Skill: Billing (Stripe)

**Domain:** Stripe subscriptions, plan entitlements, trial management, webhook processing  
**Load when:** Working on BillingModule, Stripe webhooks, plan upgrades/downgrades, trial expiry

---

## Module structure

```
src/
├── billing/
│   ├── billing.module.ts
│   ├── billing.service.ts           ← plan queries, entitlement helpers
│   ├── billing.controller.ts        ← POST /billing/checkout, /billing/portal
│   ├── stripe-webhook.controller.ts ← POST /webhooks/stripe (Stripe-verified)
│   └── trial.service.ts             ← trial expiry cron job
```

---

## Stripe products and prices

Map plan names to Stripe Price IDs (set in env):

```
STRIPE_PRICE_STARTER=price_...    # $19/mo
STRIPE_PRICE_GROWTH=price_...     # $49/mo
STRIPE_PRICE_AGENCY=price_...     # $149/mo
```

Enterprise is handled manually — no Stripe price. Do not auto-subscribe Enterprise.

---

## Checkout flow

```typescript
// POST /billing/checkout  { plan: 'starter' | 'growth' | 'agency' }
async createCheckoutSession(userId: string, plan: string): Promise<{ url: string }> {
  const user = await getUser(userId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: user.stripeCustomerId ?? undefined,
    customer_email: user.stripeCustomerId ? undefined : user.email,
    line_items: [{
      price: PRICE_MAP[plan],
      quantity: 1,
    }],
    subscription_data: {
      trial_period_days: user.plan === 'trial' && user.trialEndsAt > new Date() ? undefined : 0,
      metadata: { userId, plan },
    },
    success_url: `${process.env.APP_URL}/dashboard?checkout=success`,
    cancel_url:  `${process.env.APP_URL}/billing?checkout=cancelled`,
    metadata: { userId, plan },
  });

  return { url: session.url };
}
```

---

## Stripe webhook processing

```typescript
// stripe-webhook.controller.ts
@Post('webhooks/stripe')
async handleStripeWebhook(@Req() req: RawBodyRequest, @Headers('stripe-signature') sig: string) {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new BadRequestException('Invalid Stripe webhook signature');
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.CheckoutSession;
      await this.billing.activatePlan(session.metadata.userId, session.metadata.plan, session.subscription as string, session.customer as string);
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const plan = this.billing.planFromPriceId(sub.items.data[0].price.id);
      await this.billing.updatePlan(sub.metadata.userId, plan);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await this.billing.downgradePlan(sub.metadata.userId);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      await this.billing.handlePaymentFailure(invoice.customer as string);
      break;
    }
  }

  return { received: true };
}
```

### `activatePlan` logic
```typescript
async activatePlan(userId: string, plan: string, subId: string, customerId: string): Promise<void> {
  await db.update(users).set({
    plan,
    stripeSubId:      subId,
    stripeCustomerId: customerId,
    trialEndsAt:      null,        // trial ends on paid activation
  }).where(eq(users.id, userId));

  await notifyQueue.add('notify', {
    userId, type: 'plan_activated', channel: 'email', payload: { plan }
  });
}
```

---

## Customer portal (plan management)

```typescript
// POST /billing/portal
async createPortalSession(userId: string): Promise<{ url: string }> {
  const user = await getUser(userId);
  if (!user.stripeCustomerId) throw new BadRequestException('No active subscription');

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${process.env.APP_URL}/billing`,
  });

  return { url: session.url };
}
```

---

## Trial management

```typescript
// trial.service.ts — cron: every hour
@Cron('0 * * * *')
async expireTrials(): Promise<void> {
  const expiredTrialUsers = await db.select().from(users)
    .where(and(
      eq(users.plan, 'trial'),
      lt(users.trialEndsAt, new Date()),
    ));

  for (const user of expiredTrialUsers) {
    // Downgrade to free (no-op tier — no new inboxes, existing inboxes paused)
    await db.update(users).set({ plan: 'free' }).where(eq(users.id, user.id));
    await warmupService.pauseAllInboxes(user.id);
    await notifyQueue.add('notify', {
      userId: user.id, type: 'trial_expired', channel: 'email', payload: {}
    });
  }
}
```

---

## Plan limits reference

```typescript
export const PLAN_LIMITS = {
  free:       { inboxes: 0,   placementTests: 0, diagnosticsAi: false, slackAlerts: false },
  trial:      { inboxes: 3,   placementTests: 1, diagnosticsAi: false, slackAlerts: false },
  starter:    { inboxes: 3,   placementTests: 1, diagnosticsAi: false, slackAlerts: false },
  growth:     { inboxes: 20,  placementTests: 5, diagnosticsAi: true,  slackAlerts: true  },
  agency:     { inboxes: 100, placementTests: -1, diagnosticsAi: true, slackAlerts: true  }, // -1 = unlimited
  enterprise: { inboxes: -1,  placementTests: -1, diagnosticsAi: true, slackAlerts: true  },
};
```

---

## Environment variables

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_AGENCY=price_...
APP_URL=https://emailwarm.io
```

---

## What you never do

- **Never skip Stripe signature verification** — always `stripe.webhooks.constructEvent` with raw body
- **Never fulfill a subscription from the frontend** — fulfillment always comes from the webhook, not the checkout success redirect
- **Never hardcode price IDs** — always from environment variables
- **Never downgrade a user's plan without pausing their inboxes first** — `pauseAllInboxes()` before plan change
- **Never expose Stripe's `customer_id` or `subscription_id` in API responses to the client** — these are internal identifiers only
