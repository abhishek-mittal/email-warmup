import type { InboxAnalysis } from '@/lib/types';
import { poolInboxReadiness, poolInboxReadinessStyle } from '@/lib/plan-config';

interface Props {
  status: string;
  analysis: InboxAnalysis | null;
}

/**
 * Pool-inbox readiness badge — answers the question "is this inbox
 * safe to use as a warmup peer?". Backed by `poolInboxReadiness()`
 * (see `frontend/src/lib/plan-config.ts` for the rules).
 *
 * Distinct from `poolInboxStatusColor()` (which shows the raw DB
 * status — 'active' | 'pending' | 'error' | 'removed'). Two inboxes
 * with the same DB `status='active'` can have different readiness
 * verdicts depending on whether the DNS analysis found any critical
 * failures (DKIM missing, etc.).
 */
export function ReadinessBadge({ status, analysis }: Props) {
  const r = poolInboxReadiness(status, analysis);
  const s = poolInboxReadinessStyle(r);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}
      title={s.hint}
    >
      {s.label}
    </span>
  );
}
