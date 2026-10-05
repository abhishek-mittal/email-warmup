import { healthScoreChipColor } from '@/lib/plan-config';
import type { InboxAnalysis } from '@/lib/types';

/**
 * DNS Health chip shared by `/inboxes` and `/pool`. Green/Amber/Red based on
 * `analysis.healthScore`, or a gray "Unknown" chip when analysis is null.
 */
export function HealthChip({ analysis }: { analysis: InboxAnalysis | null }) {
  const colors = healthScoreChipColor(analysis?.healthScore ?? null);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.text}`}
    >
      {colors.label}
      {analysis ? ` · ${analysis.healthScore}` : ''}
    </span>
  );
}

/**
 * Issues text shared by `/inboxes` and `/pool`: comma-joined issue codes,
 * "Analysing…" while a pending row has no analysis yet, or "All clear".
 */
export function IssuesCell({
  analysis,
  status,
}: {
  analysis: InboxAnalysis | null;
  status: string;
}) {
  if (!analysis) {
    if (status === 'pending') {
      return <span className="text-stone-400">Analysing…</span>;
    }
    return <span className="text-stone-400">—</span>;
  }
  if (analysis.issues.length === 0) {
    return <span className="text-emerald-600">All clear</span>;
  }
  return <span className="text-stone-600">{analysis.issues.join(', ')}</span>;
}
