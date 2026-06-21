# Skill: Reputation Scoring

**Domain:** Composite reputation score computation, history, trend detection  
**Load when:** Working on ScoringModule, score-compute queue, score history queries, trend detection

---

## Module structure

```
src/
├── scoring/
│   ├── scoring.module.ts
│   ├── scoring.service.ts          ← computes score, writes to reputation_scores
│   ├── score-compute.processor.ts  ← BullMQ processor for score-compute queue
│   └── trend.service.ts            ← detects score trends, triggers alerts
```

---

## Score formula

The reputation score is a composite 0–100 integer with three weighted components:

```
SCORE = DNS_COMPONENT + BLACKLIST_COMPONENT + PLACEMENT_COMPONENT

DNS_COMPONENT      (max 30 points)
BLACKLIST_COMPONENT (max 30 points)
PLACEMENT_COMPONENT (max 40 points)
```

### DNS component (0–30)

```typescript
function computeDnsScore(dns: DnsCheckResult): number {
  let score = 30;

  if (dns.spf === 'missing')  score -= 10;
  if (dns.spf === 'softfail') score -= 4;
  if (dns.dkim === 'missing') score -= 10;
  if (dns.dkim === 'invalid') score -= 10;
  if (dns.dmarc === 'missing') score -= 5;
  if (dns.dmarc === 'none_policy') score -= 2;
  if (dns.mx === 'missing')   score -= 5;
  if (dns.rdns === 'missing') score -= 1;  // PTR record — minor

  return Math.max(0, score);
}
```

### Blacklist component (0–30)

```typescript
function computeBlacklistScore(blacklist: BlacklistResult): number {
  if (!blacklist.isClean) {
    const listedCount = blacklist.listed.length;
    // Each listing costs points; Spamhaus listings are most severe
    const spamhausHit = blacklist.listed.some(rbl => rbl.includes('spamhaus'));
    if (spamhausHit) return 0;          // Spamhaus = immediate 0
    if (listedCount >= 3) return 5;     // Multiple minor listings
    if (listedCount === 2) return 12;
    if (listedCount === 1) return 18;
  }
  return 30; // clean
}
```

### Placement component (0–40)

```typescript
function computePlacementScore(placement: PlacementResult | null): number {
  if (!placement) return 20;  // No test yet → neutral 50% score

  // Primary 100%, Promotions 50%, Spam/Missing 0%
  const weighted = placement.primaryCount * 1.0 + placement.promotionsCount * 0.5;
  const ratio = weighted / placement.seedCount;

  return Math.round(ratio * 40);
}
```

---

## Score computation trigger

Score is recomputed:
- **Daily at 08:00 UTC** — after DNS checks and blacklist checks have run (08:00 UTC → checks at 06:00 UTC)
- **Immediately after** a placement test completes
- **Immediately after** a blacklist hit is detected

```typescript
// score-compute.processor.ts
async process(job: Job<ScoreComputeJob>): Promise<void> {
  const { inboxId } = job.data;

  const [latestDns, latestBlacklist, latestPlacement] = await Promise.all([
    getLatestDnsCheck(inboxId),
    getLatestBlacklistCheck(inboxId),
    getLatestPlacementTest(inboxId),
  ]);

  const dnsScore       = computeDnsScore(latestDns);
  const blacklistScore = computeBlacklistScore(latestBlacklist);
  const placementScore = computePlacementScore(latestPlacement);
  const total          = dnsScore + blacklistScore + placementScore;

  await db.insert(reputationScores).values({
    inboxId,
    score:          total,
    dnsScore,
    blacklistScore,
    placementScore,
    trend:          await computeTrend(inboxId, total),
    recordedAt:     new Date(),
  });

  // Trigger alert if score dropped significantly
  const prev = await getPreviousScore(inboxId);
  if (prev && (prev.score - total) >= 15) {
    await alertService.notify(inboxId, 'score_drop', { prev: prev.score, current: total, delta: prev.score - total });
    await diagnosticsService.triggerDiagnostics(inboxId, 'auto_drop');
  }
}
```

---

## Trend detection

```typescript
async computeTrend(inboxId: string, currentScore: number): Promise<'up' | 'down' | 'stable'> {
  const history = await db.select().from(reputationScores)
    .where(eq(reputationScores.inboxId, inboxId))
    .orderBy(desc(reputationScores.recordedAt))
    .limit(5);

  if (history.length < 2) return 'stable';

  // Linear regression over last 5 data points
  const avgLast3 = history.slice(0, 3).reduce((s, r) => s + r.score, 0) / Math.min(3, history.length);
  const avgPrev2 = history.slice(3).reduce((s, r) => s + r.score, 0) / Math.max(1, history.slice(3).length);

  if (avgLast3 > avgPrev2 + 3) return 'up';
  if (avgLast3 < avgPrev2 - 3) return 'down';
  return 'stable';
}
```

---

## Score history API

```typescript
// GET /inboxes/:id/score?days=30
async getScoreHistory(inboxId: string, days: number): Promise<ScoreHistory> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.select().from(reputationScores)
    .where(and(
      eq(reputationScores.inboxId, inboxId),
      gte(reputationScores.recordedAt, cutoff)
    ))
    .orderBy(asc(reputationScores.recordedAt));

  return {
    inboxId,
    current: rows[rows.length - 1]?.score ?? null,
    trend:   rows[rows.length - 1]?.trend ?? 'stable',
    history: rows.map(r => ({ date: r.recordedAt, score: r.score, breakdown: { dns: r.dnsScore, blacklist: r.blacklistScore, placement: r.placementScore } })),
  };
}
```

---

## Score display conventions

| Score range | Label | Color |
|---|---|---|
| 80–100 | Excellent | Green |
| 60–79 | Good | Blue |
| 40–59 | Fair | Yellow |
| 20–39 | Poor | Orange |
| 0–19 | Critical | Red |

These must be consistent between frontend display and PDF reports.

---

## What you never do

- **Never allow a score above 100 or below 0** — clamp after computation
- **Never skip writing to `reputation_scores`** — every computation must persist; the frontend reads from this table
- **Never compute score without at least a DNS check result** — DNS is the minimum required input; a missing DNS check = critical DNS score (0 on all DNS components)
- **Never trigger a drop alert for a newly connected inbox** — only trigger when there is a previous score to compare against (history.length >= 2)
- **Never expose the raw breakdown to Growth-minus plans** — Starter/Trial see total score only; breakdown (DNS / blacklist / placement components) is Growth+ only
