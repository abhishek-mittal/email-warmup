'use client';

import { PageHeader } from '@/components/ui/PageHeader';
import { Card, ProgressBar } from '@/components/kit/ui';
import { USAGE } from '@/mock/data';

export default function LimitsSettings() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Plan and limits" description="Growth plan usage this period." />
      <Card><div className="space-y-5">{USAGE.map((u) => { const r = u.used / u.limit; return <div key={u.resource}><div className="mb-1 flex justify-between text-sm"><span className="text-stone-700">{u.resource}</span><span className="tabular-nums text-stone-500">{u.used.toLocaleString()} / {u.limit.toLocaleString()}</span></div><ProgressBar label={u.resource} value={u.used} max={u.limit} tone={r > 0.9 ? 'bad' : r > 0.7 ? 'warn' : 'brand'} /></div>; })}</div></Card>
    </>
  );
}
