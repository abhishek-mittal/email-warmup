'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { StubPage } from '@/components/kit/StubPage';
import { StatStrip } from '@/components/ui/StatStrip';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { ProgressBar } from '@/components/kit/ui';
import { PLACEMENT_BATCHES, PLACEMENT_TESTS } from '@/mock/data';

export default function BatchDetail() {
  const { id } = useParams<{ id: string }>();
  const b = PLACEMENT_BATCHES.find((x) => x.id === id) ?? PLACEMENT_BATCHES[0];
  return (
    <StubPage feature="placement">
      <Link href="/placement" className="text-xs text-stone-500 hover:text-stone-800">← Placement tests</Link>
      <h1 className="text-xl font-semibold tracking-tight text-stone-900">{b.name}</h1>
      <StatStrip stats={[{ label: 'Tests', value: b.tests, hint: 'one per mailbox' }, { label: 'Inbox rate', value: `${b.inboxRate}%`, hint: 'across the batch', tone: b.inboxRate > 85 ? 'good' : 'warn' }, { label: 'Started', value: b.started, hint: 'weekly sweep' }]} />
      <ListCard><DataTable ariaLabel="Tests in batch" rows={PLACEMENT_TESTS} rowKey={(r) => r.id} columns={[
        { key: 's', header: 'Mailbox', render: (r) => <Link href={`/placement/${r.id}`} className="font-medium text-stone-900 hover:text-brand-700">{r.sender}</Link> },
        { key: 'i', header: 'Inbox', render: (r) => <div className="w-32"><ProgressBar label="Inbox rate" value={r.inbox} max={r.inbox + r.spam + r.missing} tone={r.spam > 1 ? 'warn' : 'good'} /></div> },
        { key: 'st', header: 'Status', align: 'right', render: (r) => r.status },
      ]} /></ListCard>
    </StubPage>
  );
}
