'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, Toggle } from '@/components/kit/ui';

const EVENTS = ['Reply received', 'Mailbox paused automatically', 'Blocklist hit', 'Placement test finished', 'Weekly digest'];
const CHANNELS = ['Email', 'In app', 'Slack'];

export default function NotificationSettings() {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(EVENTS.flatMap((e) => CHANNELS.map((c) => [`${e}|${c}`, c !== 'Slack']))));
  return (
    <>
      <PageHeader eyebrow="Settings" title="Notifications" description="Choose where each alert goes." />
      <Card padded={false}>
        <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left">
          <th className="eyebrow px-5 py-2.5 font-normal">Event</th>{CHANNELS.map((c) => <th key={c} className="eyebrow px-3 py-2.5 text-center font-normal">{c}</th>)}
        </tr></thead><tbody className="divide-y divide-stone-100">
          {EVENTS.map((e) => <tr key={e}><td className="px-5 py-3 text-stone-800">{e}</td>{CHANNELS.map((c) => <td key={c} className="px-3 py-3 text-center"><Toggle label={`${e} via ${c}`} checked={on[`${e}|${c}`]} onChange={(v) => setOn((o) => ({ ...o, [`${e}|${c}`]: v }))} /></td>)}</tr>)}
        </tbody></table>
      </Card>
    </>
  );
}
