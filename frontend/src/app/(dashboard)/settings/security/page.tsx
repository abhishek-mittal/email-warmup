'use client';

import { useState } from 'react';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, Pill, SettingRow, SettingsGroup, Toggle, btnGhost, btnSecondary } from '@/components/kit/ui';
import { SESSIONS } from '@/mock/data';

export default function SecuritySettings() {
  const { preview } = useNotify();
  const [mfa, setMfa] = useState(true);
  const [sso, setSso] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Settings" title="Security" />
      <Card title="Sign-in"><SettingsGroup>
        <SettingRow title="Two-factor authentication" description="Ask for a code at sign-in."><Toggle label="Two-factor authentication" checked={mfa} onChange={setMfa} /></SettingRow>
        <SettingRow title="Require SSO" description="Members must sign in through your identity provider."><Toggle label="Require SSO" checked={sso} onChange={setSso} /></SettingRow>
        <SettingRow title="Password" description="Last changed 41 days ago."><button type="button" className={btnSecondary} onClick={() => preview('Changing the password')}>Change</button></SettingRow>
      </SettingsGroup></Card>
      <Card title="Active sessions"><ul className="divide-y divide-stone-100">
        {SESSIONS.map((s) => <li key={s.id} className="flex items-center justify-between py-3 text-sm"><span><span className="block font-medium text-stone-900">{s.device} {s.current && <Pill tone="good">This device</Pill>}</span><span className="block text-xs text-stone-500">{s.where} · {s.last}</span></span>{!s.current && <button type="button" className={btnGhost} onClick={() => preview('Signing out the session')}>Sign out</button>}</li>)}
      </ul></Card>
    </>
  );
}
