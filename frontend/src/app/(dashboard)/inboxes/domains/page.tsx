'use client';

import { useState } from 'react';
import { StubPage } from '@/components/kit/StubPage';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { StatStrip } from '@/components/ui/StatStrip';
import { Segmented } from '@/components/kit/Tabs';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { Pill, SearchBox, btnGhost } from '@/components/kit/ui';
import { DOMAINS } from '@/mock/data';

const Check = ({ ok }: { ok: boolean }) => <Pill tone={ok ? 'good' : 'bad'} dot>{ok ? 'OK' : 'Missing'}</Pill>;

export default function DomainsPage() {
  const { preview } = useNotify();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const bad = (d: (typeof DOMAINS)[number]) => !(d.spf && d.dkim && d.dmarc && d.tracking);
  const rows = DOMAINS.filter((d) => d.domain.includes(q.toLowerCase()) && (filter === 'all' || bad(d)));
  return (
    <StubPage feature="domains">
      <PageHeader eyebrow="Email" title="Sending domains" description="Authentication, tracking and redirects for every domain you send from." actions={<button type="button" className={primaryAction} onClick={() => preview('Adding mailboxes')}>Add mailboxes</button>} />
      <StatStrip stats={[{ label: 'Domains', value: DOMAINS.length, hint: 'in use' }, { label: 'Authenticated', value: DOMAINS.filter((d) => d.spf && d.dkim && d.dmarc).length, hint: 'SPF, DKIM, DMARC', tone: 'good' }, { label: 'Tracking verified', value: DOMAINS.filter((d) => d.tracking).length, hint: 'custom domain' }, { label: 'Redirects live', value: DOMAINS.filter((d) => d.redirect).length, hint: 'link tracking' }]} />
      <ListCard toolbar={<><SearchBox value={q} onChange={setQ} placeholder="Search domains…" className="w-56" /><div className="ml-auto"><Segmented label="Filter" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, { id: 'attention', label: 'Needs attention' }]} /></div></>}>
        <DataTable ariaLabel="Sending domains" rows={rows} rowKey={(r) => r.id} columns={[
          { key: 'd', header: 'Domain', render: (r) => <span className="font-medium text-stone-900">{r.domain}</span> },
          { key: 'm', header: 'Mailboxes', render: (r) => r.mailboxes },
          { key: 'a', header: 'Authentication', render: (r) => <span className="flex gap-1.5"><Check ok={r.spf} /><Check ok={r.dkim} /><Check ok={r.dmarc} /></span> },
          { key: 't', header: 'Tracking', render: (r) => <Check ok={r.tracking} /> },
          { key: 'r', header: 'Redirect', render: (r) => <Check ok={r.redirect} /> },
          { key: 'x', header: '', align: 'right', render: (r) => <button type="button" className={btnGhost} onClick={() => preview(`Setting up ${r.domain}`)}>Set up</button> },
        ]} />
      </ListCard>
    </StubPage>
  );
}
