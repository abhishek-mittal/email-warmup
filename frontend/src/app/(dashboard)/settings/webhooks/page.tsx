'use client';

import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { StatusText, btnGhost } from '@/components/kit/ui';
import { WEBHOOKS } from '@/mock/data';

export default function WebhooksSettings() {
  const { preview } = useNotify();
  return (
    <>
      <PageHeader eyebrow="Settings" title="Webhooks" description="Send events to your own endpoints." actions={<button type="button" className={primaryAction} onClick={() => preview('Adding an endpoint')}>Add endpoint</button>} />
      <ListCard><DataTable ariaLabel="Webhook endpoints" rows={WEBHOOKS} rowKey={(w) => w.id} columns={[
        { key: 'u', header: 'Endpoint', render: (w) => <span className="block max-w-xs truncate font-mono text-xs text-stone-800">{w.url}</span> },
        { key: 'e', header: 'Events', render: (w) => <span className="text-stone-600">{w.events}</span> },
        { key: 's', header: 'State', render: (w) => <StatusText tone={w.state === 'Verified' ? 'good' : 'bad'}>{w.state}</StatusText> },
        { key: 'l', header: 'Last ok', render: (w) => <span className="text-stone-500">{w.lastOk}</span> },
        { key: 'x', header: '', align: 'right', render: (w) => <button type="button" className={btnGhost} onClick={() => preview(`Sending a test event to ${w.url}`)}>Send test</button> },
      ]} /></ListCard>
    </>
  );
}
