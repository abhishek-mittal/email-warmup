'use client';

import { StubPage } from '@/components/kit/StubPage';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatStrip } from '@/components/ui/StatStrip';
import { Card, ProgressBar } from '@/components/kit/ui';
import { BarChart, LineChart } from '@/components/kit/Charts';
import { DAYS, PERF_SERIES } from '@/mock/data';

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

export default function AnalyticsPage() {
  const sent = sum(PERF_SERIES.sent);
  const pct = (xs: number[]) => `${((sum(xs) / sent) * 100).toFixed(1)}%`;
  return (
    <StubPage feature="analytics">
      <PageHeader eyebrow="Analytics" title="Warm-up activity" description="Volume and engagement across all connected mailboxes, last 14 days." />
      <StatStrip stats={[{ label: 'Warm-up emails sent', value: sent.toLocaleString(), hint: 'last 14 days' }, { label: 'Open rate', value: pct(PERF_SERIES.opens), hint: 'pool opens' }, { label: 'Reply rate', value: pct(PERF_SERIES.replies), hint: 'pool replies', tone: 'good' }, { label: 'Bounce rate', value: pct(PERF_SERIES.bounces), hint: 'hard + soft' }]} />
      <Card title="Activity by day" description="UTC days"><LineChart ariaLabel="Sent, opens, replies and bounces by day" labels={DAYS} series={[{ name: 'Sent', values: PERF_SERIES.sent, color: '#78716c' }, { name: 'Opens', values: PERF_SERIES.opens, color: '#d94f0b' }, { name: 'Replies', values: PERF_SERIES.replies, color: '#059669' }, { name: 'Bounces', values: PERF_SERIES.bounces, color: '#e11d48' }]} /></Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Mailbox health"><div className="space-y-4">{([['Healthy', 11, 'good'], ['At risk', 2, 'warn'], ['Issues', 1, 'bad']] as const).map(([l, v, t]) => <div key={l}><div className="mb-1 flex justify-between text-xs"><span className="text-stone-600">{l}</span><b className="tabular-nums text-stone-900">{v}</b></div><ProgressBar label={`${l} mailboxes`} value={v} max={14} tone={t} /></div>)}</div></Card>
        <Card title="Warm-up stage"><BarChart ariaLabel="Mailboxes by warm-up stage" data={[{ label: 'Days 1–7', value: 3 }, { label: 'Days 8–21', value: 5 }, { label: 'Days 22–35', value: 4 }, { label: 'Graduated', value: 2 }]} /></Card>
      </div>
    </StubPage>
  );
}
