'use client';

import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, Field, btnPrimary, inputCls } from '@/components/kit/ui';

export default function WorkspaceSettings() {
  const { preview } = useNotify();
  return (
    <>
      <PageHeader eyebrow="Settings" title="Workspace" description="Name, URL and defaults for everyone in the workspace." />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Workspace name">{(id) => <input id={id} className={inputCls} defaultValue="Acme Outbound" />}</Field>
          <Field label="Workspace URL" hint="Used in invite links.">{(id) => <input id={id} className={inputCls} defaultValue="acme-outbound" />}</Field>
          <Field label="Default timezone">{(id) => <select id={id} className={inputCls}><option>Asia/Kolkata</option><option>UTC</option></select>}</Field>
          <Field label="Sending window">{(id) => <select id={id} className={inputCls}><option>Weekdays 09:00–17:00</option><option>Every day</option></select>}</Field>
        </div>
        <div className="mt-4"><button type="button" className={btnPrimary} onClick={() => preview('Saving the workspace')}>Save changes</button></div>
      </Card>
    </>
  );
}
