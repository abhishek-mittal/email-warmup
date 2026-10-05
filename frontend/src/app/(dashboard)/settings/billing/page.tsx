'use client';

import Link from 'next/link';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { Card, Pill, btnSecondary } from '@/components/kit/ui';
import { INVOICES } from '@/mock/data';

export default function BillingSettings() {
  const { preview } = useNotify();
  return (
    <>
      <PageHeader eyebrow="Settings" title="Billing" description="Sample invoices. Demo credits live under Plan & credits." />
      <Card title="Growth plan" description="$99 per month" actions={<Pill tone="good" dot>Active</Pill>}><div className="flex gap-2"><button type="button" className={btnSecondary} onClick={() => preview('Changing plan')}>Change plan</button><Link href="/billing" className={btnSecondary}>Plan & credits</Link></div></Card>
      <ListCard><DataTable ariaLabel="Invoices" rows={INVOICES} rowKey={(i) => i.id} columns={[
        { key: 'd', header: 'Date', render: (i) => i.date }, { key: 'a', header: 'Amount', render: (i) => i.amount }, { key: 's', header: 'Status', render: (i) => <Pill tone="good">{i.status}</Pill> },
        { key: 'x', header: '', align: 'right', render: () => <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => preview('Downloading the invoice')}>Download</button> },
      ]} /></ListCard>
    </>
  );
}
