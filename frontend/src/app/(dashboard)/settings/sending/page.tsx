'use client';

import { useState } from 'react';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, Field, SettingRow, SettingsGroup, Toggle, btnPrimary, inputCls } from '@/components/kit/ui';

export default function SendingSettings() {
  const { preview } = useNotify();
  const [track, setTrack] = useState(true);
  const [unsub, setUnsub] = useState(true);
  const [stop, setStop] = useState(true);
  return (
    <>
      <PageHeader eyebrow="Settings" title="Sending" description="Defaults for every connected mailbox." />
      <Card><div className="grid gap-4 sm:grid-cols-2">
        <Field label="Daily limit per mailbox" hint="Soft cap; warm-up ramps still apply.">{(id) => <input id={id} type="number" className={inputCls} defaultValue={40} />}</Field>
        <Field label="Minutes between sends">{(id) => <input id={id} type="number" className={inputCls} defaultValue={9} />}</Field>
      </div>
      <SettingsGroup>
        <SettingRow title="Track opens"><Toggle label="Track opens" checked={track} onChange={setTrack} /></SettingRow>
        <SettingRow title="Add unsubscribe link" description="Required for bulk senders."><Toggle label="Add unsubscribe link" checked={unsub} onChange={setUnsub} /></SettingRow>
        <SettingRow title="Stop on reply"><Toggle label="Stop on reply" checked={stop} onChange={setStop} /></SettingRow>
      </SettingsGroup>
      <div className="mt-4"><button type="button" className={btnPrimary} onClick={() => preview('Saving sending defaults')}>Save changes</button></div></Card>
    </>
  );
}
