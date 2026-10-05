'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { StubPage } from '@/components/kit/StubPage';
import { StatStrip } from '@/components/ui/StatStrip';
import { Card, Pill } from '@/components/kit/ui';
import { ShareBar } from '@/components/kit/Charts';
import { DataTable } from '@/components/kit/DataTable';
import { PLACEMENT_TESTS, SEED_PROVIDERS } from '@/mock/data';

export default function PlacementDetail() {
  const { id } = useParams<{ id: string }>();
  const t = PLACEMENT_TESTS.find((x) => x.id === id) ?? PLACEMENT_TESTS[0];
  const total = t.inbox + t.spam + t.missing;
  return (
    <StubPage feature="placement">
      <Link href="/placement" className="text-xs text-stone-500 hover:text-stone-800">← Placement tests</Link>
      <div><h1 className="text-xl font-semibold tracking-tight text-stone-900">{t.subject}</h1><p className="mt-1 text-sm text-stone-500">From {t.sender} · {t.started}</p></div>
      <StatStrip stats={[{ label: 'Inbox', value: `${Math.round((t.inbox / total) * 100)}%`, hint: `${t.inbox} of ${total}`, tone: 'good' }, { label: 'Spam', value: `${Math.round((t.spam / total) * 100)}%`, hint: `${t.spam} seeds`, tone: t.spam ? 'bad' : 'neutral' }, { label: 'Never arrived', value: t.missing, hint: 'copies', tone: t.missing ? 'warn' : 'neutral' }, { label: 'Pace', value: 'Quick', hint: 'seed set' }]} />
      <Card title="By provider"><DataTable ariaLabel="Placement by provider" rows={SEED_PROVIDERS} rowKey={(r) => r.provider} columns={[
        { key: 'p', header: 'Provider', render: (r) => <b className="font-medium text-stone-900">{r.provider}</b> },
        { key: 'b', header: 'Result', render: (r) => <div className="w-56"><ShareBar ariaLabel={`${r.provider} placement`} parts={[{ label: 'Inbox', value: r.inbox, color: '#059669' }, { label: 'Spam', value: r.spam, color: '#e11d48' }, { label: 'Missing', value: r.missing, color: '#a8a29e' }]} /></div> },
        { key: 't', header: 'Gmail tabs', render: (r) => <span className="text-stone-500">{r.tabs}</span> },
      ]} /></Card>
      <Card title="Content check" description="Copy that was tested"><p className="text-sm text-stone-700">Nothing in the copy stands out to a spam filter.</p><div className="mt-3 flex gap-2"><Pill tone="good" dot>No spam trigger words</Pill><Pill tone="good" dot>Plain-text ratio ok</Pill><Pill tone="warn" dot>1 tracked link</Pill></div></Card>
    </StubPage>
  );
}
