import { hasFeature } from '@/lib/plan-config';
import type { Plan } from '@/lib/types';

interface Props {
  score: number | null;
  trend?: 'up' | 'down' | 'stable';
  breakdown?: { dns: number; blacklist: number; placement: number } | null;
  plan: Plan;
}

const RADIUS = 84;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Color bands:
 *   80+ green   — Excellent
 *   60–79 blue  — Good
 *   40–59 amber — Building
 *   20–39 orange — At risk
 *   0–19 red    — Critical
 */
function colorForScore(score: number): string {
  if (score >= 80) return '#059669'; // emerald-600
  if (score >= 60) return '#0284c7'; // sky-600
  if (score >= 40) return '#d97706'; // amber-600
  if (score >= 20) return '#ea580c'; // orange-600
  return '#e11d48'; // rose-600
}

function labelForScore(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Building';
  if (score >= 20) return 'At risk';
  return 'Critical';
}

export function ReputationGauge({ score, trend = 'stable', breakdown, plan }: Props) {
  const display = score ?? 0;
  const dashOffset = CIRCUMFERENCE - (display / 100) * CIRCUMFERENCE;
  const stroke = colorForScore(display);
  const showBreakdown = score !== null && hasFeature(plan, 'growth') && breakdown;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-8">
        <div className="relative flex h-48 w-48 shrink-0 items-center justify-center">
          <svg width="208" height="208" viewBox="0 0 208 208" className="-rotate-90">
            <circle
              cx="104"
              cy="104"
              r={RADIUS}
              fill="none"
              stroke="#e2e8f0"
              strokeWidth="14"
            />
            <circle
              cx="104"
              cy="104"
              r={RADIUS}
              fill="none"
              stroke={stroke}
              strokeWidth="14"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              style={{ transition: 'stroke-dashoffset 600ms ease, stroke 300ms ease' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-5xl font-semibold tracking-tight text-slate-900">
              {score == null ? '—' : Math.round(display)}
            </span>
            <span className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">
              Reputation
            </span>
            <span className="mt-2 text-sm font-medium" style={{ color: stroke }}>
              {score == null ? 'No data' : labelForScore(score)}
            </span>
            {trend !== 'stable' && score != null ? (
              <span
                className={`mt-1 text-xs font-medium ${
                  trend === 'up' ? 'text-emerald-600' : 'text-rose-600'
                }`}
              >
                {trend === 'up' ? '↑ Trending up' : '↓ Trending down'}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Score breakdown</h3>
            <p className="text-xs text-slate-500">
              {showBreakdown
                ? 'A 0–100 composite of DNS, blacklist, and placement signals.'
                : 'Detailed breakdown is available on the Growth plan and above.'}
            </p>
          </div>
          {showBreakdown && breakdown ? (
            <div className="space-y-2.5">
              <BreakdownRow label="DNS" value={breakdown.dns} max={30} />
              <BreakdownRow label="Blacklist" value={breakdown.blacklist} max={30} />
              <BreakdownRow label="Placement" value={breakdown.placement} max={40} />
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-600">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400"
                aria-hidden
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <div>
                <span className="font-medium text-slate-700">Upgrade to Growth</span> to see the
                DNS, blacklist, and placement breakdown behind this score.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BreakdownRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="font-mono text-slate-600">
          {value}/{max}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
