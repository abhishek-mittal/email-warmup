'use client';

import { useState } from 'react';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/kit/Drawer';
import { Card, Field, SettingRow, SettingsGroup, btnDanger, btnSecondary, inputCls } from '@/components/kit/ui';

export default function DangerZone() {
  const { preview } = useNotify();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <>
      <PageHeader eyebrow="Settings" title="Danger zone" />
      <Card><SettingsGroup>
        <SettingRow title="Transfer ownership" description="Make another admin the owner."><button type="button" className={btnSecondary} onClick={() => preview('Transferring ownership')}>Transfer</button></SettingRow>
        <SettingRow title="Delete workspace" description="Disconnects every mailbox and removes warm-up history. Cannot be undone."><button type="button" className={btnDanger} onClick={() => setOpen(true)}>Delete workspace</button></SettingRow>
      </SettingsGroup></Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete workspace" description="Type the workspace name to confirm. Nothing is deleted in this preview." footer={<button type="button" className={btnDanger} disabled={typed !== 'Acme Outbound'} onClick={() => { setOpen(false); setTyped(''); preview('Deleting the workspace'); }}>Delete</button>}>
        <Field label="Workspace name">{(id) => <input id={id} className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Acme Outbound" />}</Field>
      </Modal>
    </>
  );
}
