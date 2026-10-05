'use client';

import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { Avatar, Card } from '@/components/kit/ui';
import { TEAMS } from '@/mock/data';

export default function TeamsSettings() {
  const { preview } = useNotify();
  return (
    <>
      <PageHeader eyebrow="Settings" title="Teams" description="Group members to share mailboxes." actions={<button type="button" className={primaryAction} onClick={() => preview('Creating a team')}>New team</button>} />
      <div className="grid gap-4 sm:grid-cols-2">
        {TEAMS.map((t) => (
          <Card key={t.id} title={t.name} description={`${t.members.length} member${t.members.length === 1 ? '' : 's'}`}>
            <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${t.color}`} aria-hidden />{t.members.map((m) => <Avatar key={m} name={m} size="sm" />)}</div>
          </Card>
        ))}
      </div>
    </>
  );
}
