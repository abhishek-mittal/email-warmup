'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDate } from '@/lib/format';

interface Props {
  history: { date: string; score: number }[];
}

export function ScoreHistoryChart({ history }: Props) {
  if (history.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-stone-50 text-sm text-stone-500">
        No score history yet — runs daily at 06:00 UTC.
      </div>
    );
  }

  // Trim to last 30 days
  const data = history
    .slice(-30)
    .map((h) => ({ ...h, label: formatDate(h.date, '—') }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 8, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#78716c' }}
            tickLine={false}
            axisLine={{ stroke: '#e7e5e4' }}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: '#78716c' }}
            tickLine={false}
            axisLine={{ stroke: '#e7e5e4' }}
            width={32}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #e7e5e4',
              fontSize: 12,
              boxShadow: '0 4px 12px rgb(15 23 42 / 0.05)',
            }}
            formatter={(value) => [`${value} / 100`, 'Score']}
            labelStyle={{ color: '#0f172a', fontWeight: 600 }}
          />
          <Line
            type="monotone"
            dataKey="score"
            stroke="#d94f0b"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: '#d94f0b' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
