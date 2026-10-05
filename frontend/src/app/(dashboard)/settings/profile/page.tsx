'use client';

import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar, Card, Field, SettingRow, SettingsGroup, Toggle, btnPrimary, btnSecondary, inputCls } from '@/components/kit/ui';
import { useState } from 'react';

export default function ProfileSettings() {
  const { preview } = useNotify();
  const [dark, setDark] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Settings" title="Profile" description="How you appear to teammates." />
      <Card>
        <div className="flex items-center gap-4"><Avatar name="Alex Morgan" /><button type="button" className={btnSecondary} onClick={() => preview('Uploading a photo')}>Change photo</button></div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Full name">{(id) => <input id={id} className={inputCls} defaultValue="Alex Morgan" />}</Field>
          <Field label="Email" hint="Change it from Account.">{(id) => <input id={id} className={inputCls} defaultValue="alex@acme-outbound.io" disabled />}</Field>
          <Field label="Timezone">{(id) => <select id={id} className={inputCls} defaultValue="IST"><option value="IST">Asia/Kolkata (IST)</option><option>Europe/London</option><option>America/New_York</option></select>}</Field>
          <Field label="Language">{(id) => <select id={id} className={inputCls}><option>English</option></select>}</Field>
        </div>
        <SettingsGroup><SettingRow title="Dark appearance" description="Applies on this device."><Toggle label="Dark appearance" checked={dark} onChange={setDark} /></SettingRow></SettingsGroup>
        <div className="mt-4"><button type="button" className={btnPrimary} onClick={() => preview('Saving your profile')}>Save changes</button></div>
      </Card>
    </>
  );
}
