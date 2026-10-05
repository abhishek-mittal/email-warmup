'use client';

import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, SettingRow, SettingsGroup, btnSecondary } from '@/components/kit/ui';

export default function DataSettings() {
  const { preview } = useNotify();
  return (
    <>
      <PageHeader eyebrow="Settings" title="Data export and import" />
      <Card><SettingsGroup>
        {[['Export warm-up history', 'Daily sends, opens and replies per mailbox.'], ['Export placement results', 'Every seed test and where it landed.'], ['Import mailboxes', 'Upload a CSV of SMTP or IMAP accounts.'], ['Request full data export', 'A zip of everything, emailed to you.']].map(([t, d]) => <SettingRow key={t} title={t} description={d}><button type="button" className={btnSecondary} onClick={() => preview(t)}>{t.startsWith('Import') ? 'Import' : 'Export'}</button></SettingRow>)}
      </SettingsGroup></Card>
    </>
  );
}
