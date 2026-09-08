'use client';

import { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis, ReferenceDot } from 'recharts';
import { InboxStatusBadge } from '@/components/InboxStatusBadge';
import { PulseDot, type PulseState } from '@/components/PulseDot';
import { scoreColor } from '@/lib/plan-config';
import { formatDate } from '@/lib/format';
import type { ScoreHistoryResponse } from '@/lib/activity-types';

interface Props {
  email: string;
  provider: string;
  status: string;
  warmupDay: number;
  score: ScoreHistoryResponse | null;
}

/**
 * The page header for the inbox activity dashboard. Shows:
 *  - The email + a live status dot driven by the inbox.status enum
 *  - The provider name + status badge
 *  - The current warmup day (e.g. "Day 14")
 *  - The current score as a large number with colour-coded background
 *  - A trend arrow (↑/↓/→) based on `score.trend`
 *  - A 120px-tall sparkline of the last 30 days of scores
 *
 * The sparkline has no axes labels and no legend — it's purely
 * decorative context. The dot at the rightmost point of the line is
 * the latest score, which mirrors the big number above.
 */
export function InboxPageHeader({ email, provider, status, warmupDay, score }: Props) {
  const pulse: PulseState =
    status === 'active' ? 'live' : status === 'paused' ? 'busy' : status === 'error' ? 'error' : 'idle';

  const trendArrow = useMemo(() => {
    if (!score) return '→';
    return score.trend === 'up' ? '↑' : score.trend === 'down' ? '↓' : '→';
  }, [score]);

  const trendColor = useMemo(() => {
    if (!score) return 'text-slate-400';
    return score.trend === 'up' ? 'text-emerald-500' : score.trend === 'down' ? 'text-rose-500' : 'text-slate-400';
  }, [score]);

  const sparkData = useMemo(() => {
    if (!score?.history?.length) return [];
    return score.history.map((h) => ({
      x: h.recordedAt,
      score: h.score,
      label: formatDate(h.recordedAt, '—'),
    }));
  }, [score]);

  const colors = score ? scoreColor(score.current ?? 0) : null;
  const currentScoreLabel = score?.current != null ? score.current : '—';

  return (
    <header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
      {/* Left: identity + status */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{email}</h1>
          <PulseDot state={pulse} label={`Status: ${status}`} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span className="capitalize">{provider}</span>
          <span aria-hidden>·</span>
          <InboxStatusBadge status={status} />
          <span aria-hidden>·</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            Day {warmupDay}
          </span>
        </div>
      </div>

      {/* Right: score + sparkline */}
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="flex items-baseline gap-2">
            <span
              className={`font-mono text-3xl font-semibold ${colors ? colors.text : 'text-slate-900'}`}
            >
              {currentScoreLabel}
            </span>
            <span className="text-xs text-slate-400">/ 100</span>
            <span className={`text-lg font-semibold ${trendColor}`} aria-label={`Trend: ${score?.trend ?? 'stable'}`}>
              {trendArrow}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {colors ? colors.label : 'No score yet'}
          </p>
        </div>
        <div className="h-[60px] w-[160px]" aria-hidden>
          {sparkData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <YAxis hide domain={[0, 100]} />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#4f46e5"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <ReferenceDot
                  x={sparkData[sparkData.length - 1].x}
                  y={sparkData[sparkData.length - 1].score}
                  r={3}
                  fill="#4f46e5"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 text-[10px] text-slate-400">
              No history yet
            </div>
          )}
        </div>
      </div>
    </header>
  );
}