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

export interface DiagnosticAnalysis {
  primaryCause: string;
  causes: DiagnosticCause[];
  fixes: DiagnosticFix[];
  estimatedRecoveryDays: number;
}

const CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_TIMEOUT_MS = 10_000;

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

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async analyzeSpamIssues(
    inbox: InboxRow,
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
  ): Promise<DiagnosticAnalysis | null> {
    try {
      return await this.withTimeout(
        this.callClaude(inbox, dns, blacklist, placement),
        CLAUDE_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.warn(
        `Claude diagnostic analysis failed, falling back to issue-codes-only: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude API call timed out')), ms);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private async callClaude(
    inbox: InboxRow,
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
  ): Promise<DiagnosticAnalysis> {
    const prompt = this.buildDiagnosticPrompt(inbox, dns, blacklist, placement);

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: DIAGNOSTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content.find((c) => c.type === 'text');
    if (!block || block.type !== 'text') {
      throw new Error('Claude response had no text content');
    }

    return this.parseDiagnosticResponse(block.text);
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
    const parsed = JSON.parse(text);

    if (typeof parsed.primaryCause !== 'string' || parsed.primaryCause.trim() === '') {
      throw new Error('Claude response missing a non-empty primaryCause');
    }

    const causes: DiagnosticCause[] = Array.isArray(parsed.causes)
      ? parsed.causes.map((c: any) => ({
          code: String(c.code),
          explanation: String(c.explanation),
          priority: c.priority as 'critical' | 'warning' | 'info',
        }))
      : [];

    if (!Array.isArray(parsed.fixes) || parsed.fixes.length === 0) {
      throw new Error('Claude response missing fixes');
    }

    const fixes: DiagnosticFix[] = parsed.fixes.map((f: any) => {
      if (typeof f.action !== 'string' || typeof f.expectedImpact !== 'string') {
        throw new Error('Claude response fix entry missing action/expectedImpact');
      }
      return {
        step: Number(f.step),
        action: f.action,
        expectedImpact: f.expectedImpact,
      };
    });

    return {
      primaryCause: parsed.primaryCause,
      causes,
      fixes,
      estimatedRecoveryDays: Number(parsed.estimatedRecoveryDays) || 0,
    };
  }
}
