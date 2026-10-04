'use client';

import Link from 'next/link';
import { StubPage } from '@/components/kit/StubPage';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { StatStrip } from '@/components/ui/StatStrip';
import { Card, Pill } from '@/components/kit/ui';
import { LineChart, ShareBar } from '@/components/kit/Charts';
import { AT_RISK, DAYS, DELIVERABILITY_SERIES, SEED_PROVIDERS } from '@/mock/data';

export default function DeliverabilityPage() {
  const { preview } = useNotify();
  return (
    <StubPage feature="deliverability">
      <PageHeader eyebrow="Deliverability" title="Inbox placement, bounce and complaint health" actions={<button type="button" className={primaryAction} onClick={() => preview('Running a placement test')}>Run a placement test</button>} />
      <StatStrip stats={[{ label: 'Deliverability score', value: 91, hint: 'out of 100', tone: 'good' }, { label: 'Bounce rate', value: '1.2%', hint: 'under the 3% limit' }, { label: 'Complaint rate', value: '0.02%', hint: 'limit 0.10%', tone: 'good' }, { label: 'Spam placement', value: '2%', hint: 'seed tests, 14 days' }]} />
      <Card title="Over time"><LineChart percent ariaLabel="Inbox and spam placement over 14 days" labels={DAYS} series={[{ name: 'Inbox', values: DELIVERABILITY_SERIES.inbox, color: '#059669' }, { name: 'Spam', values: DELIVERABILITY_SERIES.spam, color: '#e11d48' }]} /></Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Seed test placement by provider" actions={<Link href="/placement" className="text-xs font-medium text-brand-700 hover:underline">All tests</Link>}>
          <div className="space-y-4">{SEED_PROVIDERS.map((p) => <div key={p.provider}><p className="mb-1.5 text-xs font-medium text-stone-700">{p.provider}</p><ShareBar ariaLabel={`${p.provider} placement`} parts={[{ label: 'Inbox', value: p.inbox, color: '#059669' }, { label: 'Spam', value: p.spam, color: '#e11d48' }, { label: 'Never arrived', value: p.missing, color: '#a8a29e' }]} /></div>)}</div>
        </Card>
        <Card title="Mailboxes at risk">
          <ul className="divide-y divide-stone-100">{AT_RISK.map((r) => <li key={r.mailbox} className="flex items-center justify-between py-2.5 text-sm"><span className="text-stone-800">{r.mailbox}</span><Pill tone={r.tone} dot>{r.issue}</Pill></li>)}</ul>
        </Card>
      </div>
    </StubPage>
  );
}
