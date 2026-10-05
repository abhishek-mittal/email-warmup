'use client';

import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { ROLE_MATRIX } from '@/mock/data';

const Cell = ({ on, label }: { on: boolean; label: string }) => <span className={on ? 'text-emerald-600' : 'text-stone-300'} role="img" aria-label={`${label}: ${on ? 'allowed' : 'not allowed'}`}>{on ? '✓' : '—'}</span>;

export default function RolesSettings() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Roles and access" description="What each role can do." />
      <ListCard><DataTable ariaLabel="Role permissions" rows={ROLE_MATRIX} rowKey={(r) => r.area} columns={[
        { key: 'a', header: 'Permission', render: (r) => r.area },
        ...(['owner', 'admin', 'member', 'viewer'] as const).map((k) => ({ key: k, header: k, render: (r: (typeof ROLE_MATRIX)[number]) => <Cell on={r[k]} label={k} /> })),
      ]} /></ListCard>
    </>
  );
}
