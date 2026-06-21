# Service Spec: Placement Testing

**Tasks covered:** T014  
**Primary skill file:** docs/05-agent-skills/06-skill-placement-test.md

---

## Service contracts

### PlacementService
```
runTest(inboxId, userId) → { testId: string }
  1. Assert plan quota (monthly placement test limit)
  2. Select seed list based on plan (quick: 10 seeds, full: 35 seeds)
  3. Generate unique test email subject with tracking code
  4. Send to all seed addresses via inbox's SMTP
  5. Enqueue placement-test job with sentAt timestamp
  6. Return testId immediately (results arrive asynchronously)

getResult(testId) → PlacementResult | { status: 'pending' }
getHistory(inboxId) → PlacementResult[]
```

### SeedListService
```
getSeedAddresses(type: 'quick' | 'full') → SeedAddress[]
  quick: 10 addresses (5 Gmail, 3 Outlook, 2 Yahoo)
  full: 35 addresses (20 Gmail, 10 Outlook, 5 Yahoo)

checkSeedInbox(seedInboxId, messageId) → GmailPlacement | OutlookPlacement
  Wait until sentAt + 5 minutes before checking
  Gmail: use X-GM-LABELS to detect \Category_Promotions vs \Inbox
  Outlook: check INBOX then Junk Email folder
```

---

## API contracts

```
POST /inboxes/:id/placement-test
  → { testId: string, estimatedReadyAt: ISO }

GET /inboxes/:id/placement-test/:testId
  → {
      status: 'pending' | 'complete',
      primaryPct: number,
      promotionsPct: number,
      spamPct: number,
      missingPct: number,
      placementScore: number,
      completedAt: ISO | null
    }

GET /inboxes/:id/placement-tests
  → PlacementResult[]  (last 10, most recent first)
```

---

## Placement score formula

```
placementScore = round(
  (primaryCount * 1.0 + promotionsCount * 0.5) / seedCount * 100
)
```

This contributes directly to the reputation score as the placement_score component (0–40 after scaling: placementScore * 0.4).

---

## Plan-gated test quotas

| Plan | Tests/month | Seed type |
|---|---|---|
| trial | 1 | quick |
| starter | 1 | quick |
| growth | 5 | full |
| agency | unlimited | full |
| enterprise | unlimited | full + custom |

Quota resets on the 1st of each month. Track usage in a `placement_test_usage` counter per user per month (or count rows in placement_tests table).

---

## Queue definition

```
Queue: placement-test
Concurrency: 5
Job: { testId, inboxId, seedList, sentAt }
Process: wait until sentAt + 5min, then check all seed inboxes in parallel
Timeout: 15 minutes (if seeds not reachable, mark result as incomplete)
```

---

## Acceptance criteria (T014)

- [ ] Test email lands in all 10 quick-seed inboxes within 3 minutes of send
- [ ] Gmail Promotions tab correctly classified as 'promotions' (not 'primary', not 'spam')
- [ ] Outlook Junk Email correctly classified as 'spam'
- [ ] Results available via GET endpoint within 10 minutes of test start
- [ ] placement_tests row written with correct primaryPct, promotionsPct, spamPct values
- [ ] Score recompute triggered after placement test completes
- [ ] Monthly quota enforced: second test on Starter plan returns 429
- [ ] Test that lands 100% in Primary returns placementScore = 100
- [ ] Test that lands 100% in Promotions returns placementScore = 50
