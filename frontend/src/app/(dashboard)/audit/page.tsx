'use client';

import { useState } from 'react';
import { StubPage } from '@/components/kit/StubPage';
import { PageHeader, secondaryAction } from '@/components/ui/PageHeader';
import { useNotify } from '@/components/kit/Notify';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { Avatar, SearchBox } from '@/components/kit/ui';
import { AUDIT } from '@/mock/data';

export default function AuditPage() {
  const { preview } = useNotify();
  const [q, setQ] = useState('');
  const rows = AUDIT.filter((a) => `${a.user} ${a.action} ${a.entity}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <StubPage feature="audit">
      <PageHeader eyebrow="Resources" title="Audit log" description="Every change made in the workspace." actions={<button type="button" className={secondaryAction} onClick={() => preview('Exporting the log')}>Export CSV</button>} />
      <ListCard toolbar={<SearchBox value={q} onChange={setQ} placeholder="Search by user, action or entity…" className="w-72" />}>
        <DataTable ariaLabel="Audit log" rows={rows} rowKey={(a) => a.id} columns={[
          { key: 'w', header: 'When', render: (a) => <span className="whitespace-nowrap text-stone-500">{a.when}</span> },
          { key: 'u', header: 'User', render: (a) => <span className="flex items-center gap-2"><Avatar name={a.user} size="sm" />{a.user}</span> },
          { key: 'a', header: 'Action', render: (a) => <code className="font-mono text-xs text-stone-700">{a.action}</code> },
          { key: 'e', header: 'Entity', render: (a) => a.entity },
          { key: 'd', header: 'Detail', render: (a) => <span className="text-stone-500">{a.detail}</span> },
        ]} />
      </ListCard>
    </StubPage>
  );
}
