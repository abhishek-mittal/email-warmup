/**
 * Standalone health-score gauge for the pool inbox detail panel. Copies just
 * the circular-SVG-arc rendering approach from `ReputationGauge` — that
 * component's plan-gating ("Upgrade to Growth" breakdown lock) doesn't apply
 * here: a pool inbox has no plan-gating concept, and there's no score
 * history to show, just the current `inbox_analysis.health_score`.
 */
const RADIUS = 64;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function colorForScore(score: number): string {
  if (score >= 80) return '#059669'; // emerald-600
  if (score >= 50) return '#d97706'; // amber-600
  return '#e11d48'; // rose-600
}

function labelForScore(score: number): string {
  if (score >= 80) return 'Healthy';
  if (score >= 50) return 'Needs attention';
  return 'At risk';
}

export function HealthScoreGauge({ score }: { score: number | null }) {
  const display = score ?? 0;
  const dashOffset = CIRCUMFERENCE - (display / 100) * CIRCUMFERENCE;
  const stroke = score == null ? '#a1a1aa' : colorForScore(display);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex h-36 w-36 items-center justify-center">
        <svg width="160" height="160" viewBox="0 0 160 160" className="-rotate-90">
          <circle cx="80" cy="80" r={RADIUS} fill="none" stroke="#e7e5e4" strokeWidth="12" />
          <circle
            cx="80"
            cy="80"
            r={RADIUS}
            fill="none"
            stroke={stroke}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 600ms ease, stroke 300ms ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold tracking-tight text-stone-900">
            {score == null ? '—' : Math.round(display)}
          </span>
          <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500">
            Health score
          </span>
        </div>
      </div>
      <span className="text-sm font-medium" style={{ color: stroke }}>
        {score == null ? 'No analysis yet' : labelForScore(score)}
      </span>
    </div>
  );
}
