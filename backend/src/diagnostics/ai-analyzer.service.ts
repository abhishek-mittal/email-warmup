import { Injectable, Logger } from '@nestjs/common';
import { Anthropic } from '@anthropic-ai/sdk';
import { inboxes, dnsChecks, blacklistChecks, placementTests } from '../db/schema';

type InboxRow = typeof inboxes.$inferSelect;
type DnsCheckRow = typeof dnsChecks.$inferSelect;
type BlacklistCheckRow = typeof blacklistChecks.$inferSelect;
type PlacementTestRow = typeof placementTests.$inferSelect;

export interface DiagnosticCause {
  code: string;
  explanation: string;
  priority: 'critical' | 'warning' | 'info';
}

export interface DiagnosticFix {
  step: number;
  action: string;
  expectedImpact: string;
}

export interface DiagnosticEvidence {
  /** ISO timestamps of the measurements this analysis was based on. Null when
   *  that category had no data (which the model is told is "unknown"). */
  dnsCheckedAt: string | null;
  blacklistCheckedAt: string | null;
  placementAt: string | null;
}

export interface DiagnosticAnalysis {
  primaryCause: string;
  causes: DiagnosticCause[];
  fixes: DiagnosticFix[];
  estimatedRecoveryDays: number;
  /** 'high' when a placement observation backed the analysis, else 'low'. The
   *  AI output is advisory, never a provider reputation guarantee. */
  confidence: 'high' | 'low';
  /** When the analysis was produced and which measurements fed it. */
  generatedAt: string;
  evidence: DiagnosticEvidence;
}

const CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_TIMEOUT_MS = 10_000;
const CLAUDE_MAX_TOKENS = 1024;

// Bounds applied to whatever the model returns, so a malformed or adversarial
// response can never produce unbounded or nonsensical output downstream.
const MAX_CAUSES = 10;
const MAX_FIXES = 10;
const MAX_RECOVERY_DAYS = 90;
const VALID_PRIORITIES = new Set<DiagnosticCause['priority']>(['critical', 'warning', 'info']);

// Cost budget: a simple per-process sliding window. Diagnostics are triggered by
// background jobs, so a runaway loop (or a flood of triggers) could otherwise
// spend without bound. Over budget -> skip the AI call and fall back to the
// deterministic issue codes.
const BUDGET_WINDOW_MS = 60_000;
function maxCallsPerWindow(): number {
  const parsed = Number.parseInt(process.env.ANTHROPIC_DIAGNOSTIC_MAX_CALLS_PER_MIN ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

const DIAGNOSTIC_SYSTEM_PROMPT = `You are an email deliverability expert. Given technical data about an inbox, identify the most likely root causes of spam placement issues and provide specific, actionable fixes.

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

Be concrete. Reference the specific domain, record values, and blacklist names from the data provided.`;

/**
 * Calls Claude to explain spam-placement root causes. Never throws — on
 * timeout, API error, or an unparseable/incomplete response, returns null so
 * the caller can fall back to issue-codes-only (see T015 context addendum
 * #3). Never caches results: a fresh call is made every time this is invoked.
 */
@Injectable()
export class AiAnalyzerService {
  private readonly logger = new Logger(AiAnalyzerService.name);
  private readonly client: Anthropic;
  /** Timestamps of recent AI calls, for the sliding-window cost budget. */
  private readonly recentCalls: number[] = [];

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async analyzeSpamIssues(
    inbox: InboxRow,
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
  ): Promise<DiagnosticAnalysis | null> {
    if (!this.withinBudget()) {
      this.logger.warn(
        'Claude diagnostic analysis skipped: per-minute cost budget exceeded, falling back to issue-codes-only',
      );
      return null;
    }

    // Abort the in-flight HTTP request on timeout (not just the awaiting
    // promise), so a stalled call does not hold a socket for the full SDK
    // default timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await this.callClaude(inbox, dns, blacklist, placement, controller.signal);
    } catch (err) {
      this.logger.warn(
        `Claude diagnostic analysis failed, falling back to issue-codes-only: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Records a call and reports whether it is within the per-minute budget. */
  private withinBudget(): boolean {
    const now = Date.now();
    const cutoff = now - BUDGET_WINDOW_MS;
    // Drop timestamps outside the window.
    while (this.recentCalls.length > 0 && this.recentCalls[0] < cutoff) {
      this.recentCalls.shift();
    }
    if (this.recentCalls.length >= maxCallsPerWindow()) return false;
    this.recentCalls.push(now);
    return true;
  }

  private async callClaude(
    inbox: InboxRow,
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
    signal: AbortSignal,
  ): Promise<DiagnosticAnalysis> {
    const prompt = this.buildDiagnosticPrompt(inbox, dns, blacklist, placement);

    const response = await this.client.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: DIAGNOSTIC_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal, timeout: CLAUDE_TIMEOUT_MS },
    );

    const block = response.content.find((c) => c.type === 'text');
    if (!block || block.type !== 'text') {
      throw new Error('Claude response had no text content');
    }

    const analysis = this.parseDiagnosticResponse(block.text);
    // Attach provenance: when the analysis was made and which measurements
    // (with their timestamps) backed it, plus a confidence that reflects
    // whether a placement observation was available.
    analysis.generatedAt = new Date().toISOString();
    analysis.evidence = {
      dnsCheckedAt: dns?.checkedAt ? new Date(dns.checkedAt).toISOString() : null,
      blacklistCheckedAt: blacklist?.checkedAt
        ? new Date(blacklist.checkedAt).toISOString()
        : null,
      placementAt: placement?.createdAt ? new Date(placement.createdAt).toISOString() : null,
    };
    analysis.confidence = placement && placement.spamPct !== null ? 'high' : 'low';
    return analysis;
  }

  private buildDiagnosticPrompt(
    inbox: InboxRow,
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
  ): string {
    const listed = Object.entries((blacklist?.rblResults as Record<string, string>) ?? {})
      .filter(([, status]) => status === 'listed')
      .map(([rbl]) => rbl);

    return [
      `Inbox: ${inbox.email} (provider: ${inbox.provider}, warmup day: ${inbox.warmupDay ?? 0})`,
      `SPF valid: ${dns?.spfValid ?? 'unknown'}`,
      `DKIM valid: ${dns?.dkimValid ?? 'unknown'}`,
      `DMARC valid: ${dns?.dmarcValid ?? 'unknown'}`,
      `MX valid: ${dns?.mxValid ?? 'unknown'}`,
      `rDNS valid: ${dns?.rdnsValid ?? 'unknown'}`,
      `Blacklists currently listed on: ${listed.length > 0 ? listed.join(', ') : 'none'}`,
      `Placement test — primary: ${placement?.primaryPct ?? 'unknown'}%, promotions: ${placement?.promotionsPct ?? 'unknown'}%, spam: ${placement?.spamPct ?? 'unknown'}%`,
    ].join('\n');
  }

  /**
   * Parses Claude's JSON response into the structured DiagnosticAnalysis
   * shape. A response missing primaryCause or any required fix fields is
   * treated as a parse failure (throws), same as a timeout — see T015
   * context addendum #4.
   */
  private parseDiagnosticResponse(text: string): DiagnosticAnalysis {
    const parsed = JSON.parse(stripJsonFences(text));

    if (typeof parsed.primaryCause !== 'string' || parsed.primaryCause.trim() === '') {
      throw new Error('Claude response missing a non-empty primaryCause');
    }

    // Causes: keep only well-formed entries with a valid priority enum and
    // non-empty text; cap the count. Invalid entries are dropped, not fatal.
    const causes: DiagnosticCause[] = (Array.isArray(parsed.causes) ? parsed.causes : [])
      .filter(
        (c: any) =>
          c &&
          typeof c.code === 'string' &&
          c.code.trim() !== '' &&
          typeof c.explanation === 'string' &&
          c.explanation.trim() !== '' &&
          VALID_PRIORITIES.has(c.priority),
      )
      .slice(0, MAX_CAUSES)
      .map((c: any) => ({
        code: c.code,
        explanation: c.explanation,
        priority: c.priority as DiagnosticCause['priority'],
      }));

    // Fixes are required: at least one well-formed entry with a sane step.
    const fixes: DiagnosticFix[] = (Array.isArray(parsed.fixes) ? parsed.fixes : [])
      .filter(
        (f: any) =>
          f &&
          typeof f.action === 'string' &&
          f.action.trim() !== '' &&
          typeof f.expectedImpact === 'string' &&
          f.expectedImpact.trim() !== '',
      )
      .slice(0, MAX_FIXES)
      .map((f: any, i: number) => ({
        step: Number.isFinite(Number(f.step)) ? Number(f.step) : i + 1,
        action: f.action,
        expectedImpact: f.expectedImpact,
      }));

    if (fixes.length === 0) {
      throw new Error('Claude response had no valid fixes');
    }

    // Clamp recovery days to a finite, non-negative, bounded integer.
    const rawDays = Number(parsed.estimatedRecoveryDays);
    const estimatedRecoveryDays = Number.isFinite(rawDays)
      ? Math.min(MAX_RECOVERY_DAYS, Math.max(0, Math.round(rawDays)))
      : 0;

    // Provenance fields are filled in by the caller (callClaude); start with
    // safe defaults so the shape is always complete.
    return {
      primaryCause: parsed.primaryCause.trim(),
      causes,
      fixes,
      estimatedRecoveryDays,
      confidence: 'low',
      generatedAt: new Date().toISOString(),
      evidence: { dnsCheckedAt: null, blacklistCheckedAt: null, placementAt: null },
    };
  }
}

/**
 * Models sometimes wrap JSON in a ```json … ``` fence or add prose around it.
 * Strip a leading/trailing code fence and, failing that, slice to the outermost
 * braces so JSON.parse sees clean JSON.
 */
function stripJsonFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  if (!t.startsWith('{')) {
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first !== -1 && last > first) t = t.slice(first, last + 1);
  }
  return t;
}
