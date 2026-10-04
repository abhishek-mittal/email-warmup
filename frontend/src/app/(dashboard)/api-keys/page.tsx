'use client';

import { useState } from 'react';
import { StubPage } from '@/components/kit/StubPage';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { Modal } from '@/components/kit/Drawer';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/kit/ui';
import { API_KEYS } from '@/mock/data';

export default function ApiKeysPage() {
  const { preview } = useNotify();
  const [open, setOpen] = useState(false);
  return (
    <StubPage feature="api_keys">
      <PageHeader eyebrow="Resources" title="API keys" description="Keys authenticate scripts and integrations." actions={<button type="button" className={primaryAction} onClick={() => setOpen(true)}>Create key</button>} />
      <ListCard><DataTable ariaLabel="API keys" rows={API_KEYS} rowKey={(k) => k.id} columns={[
        { key: 'n', header: 'Name', render: (k) => <span className="font-medium text-stone-900">{k.name}</span> },
        { key: 'p', header: 'Key', render: (k) => <code className="font-mono text-xs text-stone-600">{k.prefix}</code> },
        { key: 's', header: 'Scopes', render: (k) => <span className="text-stone-600">{k.scopes}</span> },
        { key: 'l', header: 'Last used', render: (k) => <span className="text-stone-500">{k.last}</span> },
        { key: 'r', header: 'Requests', render: (k) => k.requests.toLocaleString() },
        { key: 'x', header: '', align: 'right', render: (k) => <button type="button" className={btnGhost} onClick={() => preview(`Revoking ${k.name}`)}>Revoke</button> },
      ]} /></ListCard>
      <Modal open={open} onClose={() => setOpen(false)} title="Create API key" description="The secret is shown once." footer={<button type="button" className={btnPrimary} onClick={() => { setOpen(false); preview('Creating a key'); }}>Create</button>}>
        <Field label="Name">{(id) => <input id={id} className={inputCls} placeholder="Zapier production" />}</Field>
      </Modal>
    </StubPage>
  );
}
