'use client';

import Link from 'next/link';
import { useState } from 'react';
import { StubPage } from '@/components/kit/StubPage';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction, secondaryAction } from '@/components/ui/PageHeader';
import { Tabs } from '@/components/kit/Tabs';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { ShareBar } from '@/components/kit/Charts';
import { StatusText } from '@/components/kit/ui';
import { PLACEMENT_BATCHES, PLACEMENT_TESTS } from '@/mock/data';

export default function PlacementPage() {
  const { preview } = useNotify();
  const [tab, setTab] = useState<'tests' | 'batches'>('tests');
  return (
    <StubPage feature="placement">
      <PageHeader eyebrow="Deliverability" title="Placement tests" description="Send a test to seed inboxes and see where it lands." actions={<><button type="button" className={secondaryAction} onClick={() => preview('Starting a batch')}>New batch</button><button type="button" className={primaryAction} onClick={() => preview('Starting a test')}>New test</button></>} />
      <Tabs label="Placement sections" value={tab} onChange={setTab} tabs={[{ id: 'tests', label: 'Tests', count: PLACEMENT_TESTS.length }, { id: 'batches', label: 'Batches', count: PLACEMENT_BATCHES.length }]} />
      <ListCard>
        {tab === 'tests' ? (
          <DataTable ariaLabel="Placement tests" rows={PLACEMENT_TESTS} rowKey={(r) => r.id} columns={[
            { key: 's', header: 'Sender and subject', render: (r) => <Link href={`/placement/${r.id}`} className="block"><span className="block font-medium text-stone-900">{r.sender}</span><span className="block text-xs text-stone-500">{r.subject}</span></Link> },
            { key: 'w', header: 'Where it landed', render: (r) => <div className="w-48"><ShareBar ariaLabel="Placement" parts={[{ label: 'Inbox', value: r.inbox, color: '#059669' }, { label: 'Spam', value: r.spam, color: '#e11d48' }, { label: 'Missing', value: r.missing, color: '#a8a29e' }]} /></div> },
            { key: 'st', header: 'Status', render: (r) => <StatusText tone={r.status === 'Running' ? 'info' : 'good'}>{r.status}</StatusText> },
            { key: 'd', header: 'Started', align: 'right', render: (r) => <span className="text-stone-500">{r.started}</span> },
          ]} />
        ) : (
          <DataTable ariaLabel="Placement batches" rows={PLACEMENT_BATCHES} rowKey={(r) => r.id} columns={[
            { key: 'n', header: 'Batch', render: (r) => <Link href={`/placement/batches/${r.id}`} className="font-medium text-stone-900 hover:text-brand-700">{r.name}</Link> },
            { key: 't', header: 'Tests', render: (r) => r.tests },
            { key: 'i', header: 'Inbox rate', render: (r) => `${r.inboxRate}%` },
            { key: 'd', header: 'Started', align: 'right', render: (r) => <span className="text-stone-500">{r.started}</span> },
          ]} />
        )}
      </ListCard>
    </StubPage>
  );
}
