# T016 — Stripe Billing + Trial

**Wave:** 5  
**Depends on:** T004  
**Skills to load:** docs/05-agent-skills/09-skill-billing.md  
**Service spec:** __specs__/services/billing.md

---

## What to build

Full Stripe integration: checkout sessions, webhook fulfillment, customer portal, plan entitlements, and trial expiry.

### BillingModule (`billing/`)

**BillingService** (`billing/billing.service.ts`)
- `createCheckoutSession(userId, plan)` → Stripe Checkout URL
- `createPortalSession(userId)` → Stripe Portal URL
- `activatePlan(userId, plan, subId, customerId)` — called by webhook
- `updatePlan(userId, plan)` — called by subscription.updated
- `downgradePlan(userId)` — calls `warmupService.pauseAllInboxes(userId)` then sets plan='free'
- `handlePaymentFailure(customerId)` — sends email notification
- `planFromPriceId(priceId)` — maps Stripe price ID → plan name
- Export `PLAN_LIMITS` constant (source of truth for all entitlement checks)

**StripeWebhookController** (`billing/stripe-webhook.controller.ts`)
- `POST /webhooks/stripe` — raw body required for signature verification
- Handle: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Verify with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`
- Idempotent: use Stripe event ID to prevent double-processing

**BillingController** (`billing/billing.controller.ts`)
- `POST /billing/checkout` → checkout session URL
- `POST /billing/portal` → portal session URL
- `GET /billing/status` → current plan, usage, limits

**TrialService** (`billing/trial.service.ts`)
- Cron: every hour
- Find users WHERE plan='trial' AND trial_ends_at < now()
- For each: set plan='free', pause all inboxes, send trial_expired notification

---

## Acceptance criteria

- [ ] `POST /billing/checkout` returns a valid Stripe checkout URL
- [ ] Stripe webhook `checkout.session.completed` activates plan and sets stripeCustomerId
- [ ] Stripe webhook with invalid signature returns 400 (not 200, not 500)
- [ ] `subscription.deleted` sets plan to 'free' and pauses all inboxes
- [ ] `invoice.payment_failed` triggers email notification within 60 seconds
- [ ] Trial expiry cron runs hourly and processes all users with expired trial_ends_at
- [ ] After trial expiry, `POST /inboxes/connect/*` returns 403 for that user
- [ ] `GET /billing/status` returns correct inboxes used vs. limit
- [ ] Stripe price IDs come from environment variables (no hardcoded values in code)
- [ ] Double webhook delivery does not double-activate plan (idempotency check)

## Mark done in SPEC-STATUS.md when all criteria above are verified
