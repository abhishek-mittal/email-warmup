# Service Spec: Billing

**Tasks covered:** T016  
**Primary skill file:** docs/05-agent-skills/09-skill-billing.md

---

## Service contracts

### BillingService
```
createCheckoutSession(userId, plan) → { url: string }
  Creates Stripe Checkout in subscription mode
  Passes plan in metadata for webhook fulfillment

createPortalSession(userId) → { url: string }
  Creates Stripe Billing Portal session for self-serve plan management

activatePlan(userId, plan, subId, customerId) → void
  Called by webhook on checkout.session.completed
  Sets user.plan, user.stripeSubId, user.stripeCustomerId, clears trial

updatePlan(userId, plan) → void
  Called by webhook on subscription.updated

downgradePlan(userId) → void
  Called by webhook on subscription.deleted
  Sets plan = 'free', calls pauseAllInboxes(userId)

handlePaymentFailure(customerId) → void
  Find user by stripeCustomerId
  Notify via email (type: 'payment_failed')
```

### TrialService
```
expireTrials() → void
  Cron: every hour
  Find users WHERE plan='trial' AND trial_ends_at < now()
  For each: set plan='free', pauseAllInboxes, send trial_expired notification
```

---

## API contracts

```
POST /billing/checkout    body: { plan: 'starter'|'growth'|'agency' }
  → { url: string }       (Stripe checkout URL — redirect user)

POST /billing/portal
  → { url: string }       (Stripe portal URL — redirect user)

GET /billing/status
  → {
      plan: string,
      trialEndsAt: ISO | null,
      inboxesUsed: number,
      inboxLimit: number,
      billingPortalUrl: string | null
    }

POST /webhooks/stripe     (raw body required, Stripe-Signature header)
  → { received: true }
```

---

## Plan limits (source of truth — used by all entitlement checks)

| Plan | Inboxes | Placement tests/mo | AI diagnostics | Slack alerts | White-label |
|---|---|---|---|---|---|
| free | 0 | 0 | no | no | no |
| trial | 3 | 1 | no | no | no |
| starter | 3 | 1 | no | no | no |
| growth | 20 | 5 | yes | yes | no |
| agency | 100 | unlimited | yes | yes | yes |
| enterprise | unlimited | unlimited | yes | yes | yes |

Export `PLAN_LIMITS` constant from `billing.service.ts` — import it everywhere else.

---

## Acceptance criteria (T016)

- [ ] Trial user (plan='trial') can initiate Stripe checkout and receive checkout URL
- [ ] Stripe checkout.session.completed webhook activates plan without double-fulfillment (idempotent)
- [ ] subscription.deleted webhook downgrades user to 'free' and pauses all inboxes
- [ ] payment_failed webhook sends email notification within 60 seconds
- [ ] Portal URL works for users with existing Stripe subscription
- [ ] Trial expiry cron runs hourly and processes all expired trials
- [ ] After trial expiry, new inbox connections are rejected with 403
- [ ] PLAN_LIMITS['growth'].inboxes = 20 and assertInboxLimit enforces this correctly
- [ ] Stripe webhook returns 400 on invalid signature (never 200)
