# T015 — AI Diagnostics + Readiness Report

**Wave:** 4  
**Depends on:** T013 (scoring), T014 (placement)  
**Skills to load:** docs/05-agent-skills/07-skill-diagnostics.md

---

## What to build

The diagnostics module that calls Claude API to explain why an inbox is in spam and generates a post-warmup readiness report on graduation.

### DiagnosticsModule (`diagnostics/`)

**DiagnosticsService** (`diagnostics/diagnostics.service.ts`)
- `triggerDiagnostics(inboxId, triggerType)` — called by monitoring (blacklist hit, score drop) or manually
  1. Assert plan is Growth+ (AI analysis for Growth/Agency/Enterprise only)
  2. Load latest DNS, blacklist, and placement data
  3. Call `AiAnalyzerService.analyzeSpamIssues(inbox, dns, blacklist, placement)`
  4. Parse AI response into `DiagnosticAnalysis` struct
  5. Insert into `diagnostics` table

**AiAnalyzerService** (`diagnostics/ai-analyzer.service.ts`)
- Calls `claude-haiku-4-5` with 10s timeout
- System prompt: deliverability expert, output structured JSON
- If Claude API fails or times out: use issue code list from DNS/blacklist data directly (no AI explanation, but codes still surface)
- Parse response: `{ primaryCause, causes[], fixes[], estimatedRecoveryDays }`

**ReadinessReportService** (`diagnostics/readiness-report.service.ts`)
- `generateReadinessReport(inboxId)` — called when inbox graduates
- Computes `recommendedDailySendVolume` based on score + placement
- Generates `nextSteps` and `riskFactors` arrays
- Saves to `diagnostics.readiness_report` JSONB column

### API

```
GET /inboxes/:id/diagnostics
  → {
      issueCodes: string[],
      aiAnalysis: DiagnosticAnalysis | null,  ← null for non-Growth plans
      readinessReport: ReadinessReport | null, ← null if not yet graduated
      createdAt: ISO
    }

POST /inboxes/:id/diagnostics/run
  → { diagnosticId: string }  (async, Growth+ plan only)
```

---

## Acceptance criteria

- [ ] `GET /inboxes/:id/diagnostics` returns issue codes for all plans (Starter included)
- [ ] `aiAnalysis` is null for Starter/Trial plan users (not just omitted)
- [ ] `DiagnosticAnalysis.primaryCause` is a non-empty string
- [ ] `DiagnosticAnalysis.fixes` contains at least one step with `action` and `expectedImpact`
- [ ] Claude API timeout falls back gracefully — issue codes still returned, `aiAnalysis` is null
- [ ] `readinessReport.recommendedDailySendVolume` is capped at 200
- [ ] Readiness report triggered automatically on graduation (not only on manual request)
- [ ] `diagnostics` table row written with trigger type and all JSONB fields populated

## Mark done in SPEC-STATUS.md when all criteria above are verified
