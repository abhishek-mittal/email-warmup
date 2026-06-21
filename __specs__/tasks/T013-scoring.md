# T013 — Reputation Score Computation

**Wave:** 3  
**Depends on:** T011, T012  
**Skills to load:** docs/05-agent-skills/08-skill-scoring.md

---

## What to build

The BullMQ processor that computes the composite 0–100 reputation score from the latest DNS, blacklist, and placement data, stores the history, and triggers drop alerts.

### ScoreComputeProcessor (`scoring/score-compute.processor.ts`)

Process a job from the `score-compute` queue:

1. Load latest `dns_checks` row for the inbox
2. Load latest `blacklist_checks` row for the inbox
3. Load latest `placement_tests` row for the inbox (may be null)
4. Compute components:
   - `dnsScore = computeDnsScore(latestDns)` — 0–30
   - `blacklistScore = computeBlacklistScore(latestBlacklist)` — 0–30
   - `placementScore = computePlacementScore(latestPlacement)` — 0–40 (20 if null)
5. `total = dnsScore + blacklistScore + placementScore`
6. Compute trend: compare avg of last 3 scores vs avg of scores 4–5 positions back
7. Insert into `reputation_scores`
8. Compare with previous score:
   - If drop >= 15 points: enqueue `notify` (type `score_drop`) + trigger diagnostics (`auto_drop`)

### ScoringService (`scoring/scoring.service.ts`)

Export helper functions (for use in other modules):
- `computeDnsScore(dns)` — applies penalty table from skill file
- `computeBlacklistScore(blacklist)` — Spamhaus = 0, tiered by listed count
- `computePlacementScore(placement | null)` — formula: (primary * 1.0 + promotions * 0.5) / total * 40
- `computeTrend(inboxId, currentScore)` — 'up'|'down'|'stable'

### API

```
GET /inboxes/:id/score
  → {
      current: number,
      trend: 'up'|'down'|'stable',
      breakdown: { dns: number, blacklist: number, placement: number } | null,
      history: { date: ISO, score: number }[]
    }
  breakdown is null for trial/starter plans
```

---

## Acceptance criteria

- [ ] Score clamped between 0 and 100 (never negative, never > 100)
- [ ] `GET /inboxes/:id/score` returns valid score with `trend` field
- [ ] DNS score for inbox with SPF_MISSING + DKIM_MISSING = 30 - 10 - 10 = 10
- [ ] Blacklist score for Spamhaus listing = 0
- [ ] Placement score for 100% Primary = 40
- [ ] Placement score for 100% Promotions = 20
- [ ] Placement score for null (no test) = 20
- [ ] Score drop of 15+ points triggers `score_drop` notify job and diagnostics
- [ ] Score drop alert NOT triggered for newly connected inbox with no history
- [ ] Breakdown hidden (null) for trial/starter plan users

## Mark done in SPEC-STATUS.md when all criteria above are verified
