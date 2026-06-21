# Skill: Placement Test

**Domain:** Inbox placement testing, seed list, Promotions vs Primary detection  
**Load when:** Working on PlacementModule, placement-test queue, seed inbox management, placement analysis

---

## Module structure

```
src/
├── placement/
│   ├── placement.module.ts
│   ├── placement.service.ts         ← triggers test, stores results
│   ├── placement-test.processor.ts  ← BullMQ processor for placement-test queue
│   ├── seed-list.service.ts         ← manages internal seed inboxes
│   └── placement-analyzer.service.ts← classifies where email landed
```

---

## What a placement test does

A placement test answers: *"If I sent a real email from this inbox right now, where would it land?"*

```
1. User requests test (manual or automated post-warmup)
2. System sends a test email from the user's inbox to every seed address
3. Each seed inbox checks IMAP 5 minutes after send:
   - Is the email in INBOX → INBOX sub-tab: Primary or Promotions?
   - Is it in [Gmail]/Spam or Junk?
4. Results aggregated: Primary% / Promotions% / Spam% / Missing%
5. Score contribution: Primary emails count full, Promotions count half, Spam count zero
6. Report surfaced on dashboard within 10 minutes of test completion
```

---

## Seed list

The seed list is a set of internal inboxes controlled by the platform, spread across:
- 20 Gmail accounts (different Google Workspace domains, 4+ domains)
- 10 Outlook accounts (Hotmail + Office365)
- 5 Yahoo accounts (for completeness — lower weight)

```typescript
// seed-list.service.ts
async getSeedAddresses(testType: 'full' | 'quick'): Promise<SeedAddress[]> {
  // Full test: all seeds (~35 addresses)
  // Quick test (Trial/Starter): 10 seeds (5 Gmail, 3 Outlook, 2 Yahoo)
  const limit = testType === 'quick' ? 10 : undefined;
  return db.select().from(seedInboxes)
    .where(eq(seedInboxes.active, true))
    .limit(limit ?? 9999);
}
```

---

## Placement analyzer (the key differentiator)

### Gmail tab detection

Gmail uses IMAP labels. The email's location is determined by which labels are present:

```typescript
async analyzeGmailPlacement(client: ImapFlow, messageId: string): Promise<GmailPlacement> {
  // Search for message by Message-ID header
  const uid = await client.search({ header: ['Message-ID', messageId] });
  if (!uid.length) return 'missing';

  // Fetch labels (X-GM-LABELS IMAP extension)
  const msg = await client.fetchOne(uid[0], { labels: true } as any);
  const labels: string[] = msg.labels ?? [];

  if (labels.includes('\\Spam'))               return 'spam';
  if (labels.includes('\\Category_Promotions')) return 'promotions';
  if (labels.includes('\\Category_Social'))     return 'social';
  if (labels.includes('\\Inbox'))               return 'primary';

  return 'other';
}
```

### Outlook folder detection

```typescript
async analyzeOutlookPlacement(client: ImapFlow, messageId: string): Promise<OutlookPlacement> {
  const folders = ['INBOX', 'Junk Email', 'Clutter'];

  for (const folder of folders) {
    await client.mailboxOpen(folder);
    const uid = await client.search({ header: ['Message-ID', messageId] });
    if (uid.length) {
      if (folder === 'Junk Email') return 'spam';
      if (folder === 'Clutter')    return 'clutter';
      return 'inbox';
    }
  }
  return 'missing';
}
```

---

## Result aggregation

```typescript
interface PlacementResult {
  inboxId:      string;
  testId:       string;
  seedCount:    number;
  primaryCount: number;
  promotionsCount: number;
  spamCount:    number;
  missingCount: number;
  primaryPct:   number;   // primaryCount / seedCount * 100
  promotionsPct: number;
  spamPct:      number;
  placementScore: number; // used in reputation scoring
  completedAt:  Date;
}

function computePlacementScore(result: PlacementResult): number {
  // Primary counts 100%, Promotions counts 50%, Spam/Missing count 0%
  const weighted = result.primaryCount * 1.0 + result.promotionsCount * 0.5;
  return Math.round((weighted / result.seedCount) * 100);
}
```

---

## Plan-gated test frequency

| Plan | Tests per month | Test type |
|---|---|---|
| Trial | 1 | Quick (10 seeds) |
| Starter | 1 | Quick (10 seeds) |
| Growth | 5 | Full (35 seeds) |
| Agency | Unlimited | Full (35 seeds) |
| Enterprise | Unlimited | Full (35 seeds + custom seed list) |

Enforce in `placement.service.ts` before enqueuing:
```typescript
await assertPlan(userId, requiredForFullTest ? ['growth', 'agency', 'enterprise'] : ['trial', 'starter', 'growth', 'agency', 'enterprise']);
await assertTestQuota(userId, user.plan);
```

---

## Queue design

Queue: `placement-test`  
Concurrency: 5 (limit concurrent IMAP connections to seed inboxes)

```typescript
// Job payload
interface PlacementTestJob {
  testId:   string;
  inboxId:  string;
  seedList: SeedAddress[];
  sentAt:   string; // ISO — wait at least 5 min before checking
}

// Processor waits until sentAt + 5 minutes before opening IMAP
const waitMs = Math.max(0, new Date(job.data.sentAt).getTime() + 5 * 60_000 - Date.now());
await sleep(waitMs);
```

---

## What you never do

- **Never classify Promotions as spam** — Promotions tab is a separate, less-severe outcome. Spam and Promotions must remain distinct in results and in the reputation score formula.
- **Never use the user's real inbox as a seed** — seed inboxes are platform-controlled accounts only
- **Never check placement before the 5-minute wait** — Gmail needs time to route the email to the right tab
- **Never skip the plan-gated quota check** — placement tests are a key plan differentiator
- **Never store the full seed inbox credentials in the job payload** — resolve them from DB at job processing time
