'use client';

import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatStrip } from '@/components/ui/StatStrip';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { Card, Pill, btnSecondary, inputCls } from '@/components/kit/ui';
import { REFERRALS } from '@/mock/data';

export default function ReferralSettings() {
  const { preview } = useNotify();
  const link = 'https://emailwarm.dev/r/acme-outbound';
  return (
    <>
      <PageHeader eyebrow="Settings" title="Refer and earn" description="Earn credit when a referred workspace subscribes." />
      <StatStrip stats={[{ label: 'Referred', value: REFERRALS.length, hint: 'workspaces' }, { label: 'Earned', value: '$25', hint: 'paid out', tone: 'good' }, { label: 'Pending', value: '$25', hint: 'qualified' }]} />
      <Card title="Your link"><div className="flex gap-2"><input readOnly aria-label="Referral link" className={inputCls} value={link} /><button type="button" className={btnSecondary} onClick={() => { void navigator.clipboard?.writeText(link); preview('Copying the link'); }}>Copy</button></div></Card>
      <ListCard><DataTable ariaLabel="Referrals" rows={REFERRALS} rowKey={(r) => r.id} columns={[{ key: 'o', header: 'Workspace', render: (r) => r.org }, { key: 's', header: 'Status', render: (r) => <Pill tone={r.status === 'Rewarded' ? 'good' : 'info'}>{r.status}</Pill> }, { key: 'r', header: 'Reward', render: (r) => r.reward }, { key: 'd', header: 'Date', align: 'right', render: (r) => <span className="text-stone-500">{r.date}</span> }]} /></ListCard>
    </>
  );
}
