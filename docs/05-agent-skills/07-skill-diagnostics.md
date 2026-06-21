# Skill: Diagnostics (AI Spam Analysis + Readiness Report)

**Domain:** AI-powered spam cause analysis, actionable fix recommendations, post-warmup readiness report  
**Load when:** Working on DiagnosticsModule, Claude API integration, readiness report generation

---

## Module structure

```
src/
├── diagnostics/
│   ├── diagnostics.module.ts
│   ├── diagnostics.service.ts       ← orchestrates analysis, stores results
│   ├── diagnostics.controller.ts    ← GET /inboxes/:id/diagnostics
│   ├── ai-analyzer.service.ts       ← calls Claude API for cause analysis
│   └── readiness-report.service.ts  ← generates post-warmup readiness report
```

---

## When diagnostics run

Diagnostics are triggered automatically when:
1. **Spam placement detected** — placement test returns `spamPct > 20%`
2. **Reputation score drops** — score falls > 15 points in one day
3. **Blacklist hit detected** — any RBL listing found
4. **User manually requests** — `POST /inboxes/:id/diagnostics/run`

---

## Diagnostic issue codes

| Code | Severity | Category | Fix |
|---|---|---|---|
| `SPF_MISSING` | critical | DNS | Add SPF TXT record to domain DNS |
| `SPF_SOFTFAIL` | warning | DNS | Change `~all` to `-all` in SPF record |
| `DKIM_MISSING` | critical | DNS | Generate DKIM keypair, add TXT record |
| `DKIM_INVALID` | critical | DNS | Check DKIM public key TXT record is correct |
| `DMARC_MISSING` | warning | DNS | Add `_dmarc` TXT record |
| `DMARC_NONE` | warning | DNS | Change DMARC policy from `p=none` to `p=quarantine` |
| `MX_MISSING` | critical | DNS | DNS misconfigured — add MX record |
| `BLACKLIST_HIT` | critical | Blacklist | Request delisting from listed RBL |
| `SPAM_RATE_HIGH` | critical | Placement | Review sending content and volume |
| `PROMOTIONS_RATE_HIGH` | warning | Placement | Reduce HTML content, unsubscribe links |
| `LOW_ENGAGEMENT` | warning | Warmup | Warmup pool engagement below threshold |
| `TOKEN_EXPIRED` | critical | Auth | Reconnect inbox — OAuth token revoked |
| `WARMUP_TOO_FAST` | warning | Config | Reduce warmup speed setting |
| `VOLUME_TOO_HIGH` | warning | Config | Reduce daily send volume |
| `RDNS_MISSING` | info | DNS | Add PTR record for sending IP |

---

## AI cause analysis (Claude API)

```typescript
// ai-analyzer.service.ts

async analyzeSpamIssues(
  inbox: Inbox,
  dnsResult: DnsCheckResult,
  blacklistResult: BlacklistResult,
  placementResult: PlacementResult,
): Promise<DiagnosticAnalysis> {

  const prompt = buildDiagnosticPrompt({
    email: inbox.email,
    provider: inbox.provider,
    warmupDay: inbox.warmupDay,
    spfStatus: dnsResult.spf,
    dkimStatus: dnsResult.dkim,
    dmarcStatus: dnsResult.dmarc,
    blacklists: blacklistResult.listed,
    primaryPct: placementResult.primaryPct,
    spamPct: placementResult.spamPct,
    promotionsPct: placementResult.promotionsPct,
  });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',     // fast + cheap for structured analysis
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    system: DIAGNOSTIC_SYSTEM_PROMPT,
  });

  return parseDiagnosticResponse(response.content[0].text);
}
```

### System prompt
```
You are an email deliverability expert. Given technical data about an inbox, identify the most likely root causes of spam placement issues and provide specific, actionable fixes.

Output JSON with this structure:
{
  "primaryCause": "one sentence — the single most likely root cause",
  "causes": [
    { "code": "SPF_MISSING", "explanation": "...", "priority": "critical|warning|info" }
  ],
  "fixes": [
    { "step": 1, "action": "...", "expectedImpact": "..." }
  ],
  "estimatedRecoveryDays": 7
}

Be concrete. Reference the specific domain, record values, and blacklist names from the data provided.
```

---

## Post-warmup readiness report

Generated automatically when `checkGraduation()` returns true (warmup day 21+ for fast, 35+ for medium, 56+ for slow).

```typescript
// readiness-report.service.ts

interface ReadinessReport {
  inboxId:          string;
  generatedAt:      Date;
  warmupDaysCompleted: number;
  reputationScore:  number;
  primaryPlacementPct: number;
  recommendedDailySendVolume: number;
  warmupPoolContribution:     string;   // e.g. "Your inbox helped warm 847 other inboxes"
  nextSteps: string[];
  riskFactors: string[];
}

async generateReadinessReport(inboxId: string): Promise<ReadinessReport> {
  const inbox = await getInbox(inboxId);
  const scores = await getReputationHistory(inboxId, 7); // last 7 days
  const latestPlacement = await getLatestPlacement(inboxId);

  const avgScore = scores.reduce((s, r) => s + r.score, 0) / scores.length;
  const recommended = computeRecommendedVolume(avgScore, latestPlacement.primaryPct);

  return {
    inboxId,
    generatedAt: new Date(),
    warmupDaysCompleted: inbox.warmupDay,
    reputationScore: avgScore,
    primaryPlacementPct: latestPlacement.primaryPct,
    recommendedDailySendVolume: recommended,
    warmupPoolContribution: await getPoolContributionSummary(inboxId),
    nextSteps: buildNextSteps(avgScore, latestPlacement),
    riskFactors: buildRiskFactors(inbox, scores),
  };
}

function computeRecommendedVolume(score: number, primaryPct: number): number {
  // Conservative: only recommend high volume if both score and placement are strong
  if (score >= 80 && primaryPct >= 85) return 150;
  if (score >= 70 && primaryPct >= 75) return 80;
  if (score >= 60 && primaryPct >= 60) return 40;
  return 20; // still building reputation
}
```

---

## Storage

```typescript
// diagnostics table
export const diagnostics = pgTable('diagnostics', {
  id:            uuid('id').defaultRandom().primaryKey(),
  inboxId:       uuid('inbox_id').notNull().references(() => inboxes.id),
  triggerType:   text('trigger_type').notNull(), // auto_spam|auto_drop|auto_blacklist|manual
  issueCodes:    jsonb('issue_codes').notNull(), // string[]
  aiAnalysis:    jsonb('ai_analysis'),           // DiagnosticAnalysis
  readinessReport: jsonb('readiness_report'),    // ReadinessReport
  resolvedAt:    timestamp('resolved_at'),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
});
```

---

## What you never do

- **Never show raw Claude API response to the user** — always parse into the structured `DiagnosticAnalysis` type before returning
- **Never generate a readiness report without a completed placement test** — `primaryPlacementPct` is required data
- **Never cache AI analysis results** — each diagnosis is context-specific and must be freshly generated
- **Never recommend > 200 emails/day regardless of score** — the system cap is 200/day for any single inbox
- **Never run AI analysis on Starter plan or Trial** — diagnostics (AI cause analysis) are Growth+ only; surface issue codes without AI explanation on lower plans
