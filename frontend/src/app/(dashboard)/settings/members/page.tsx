'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, ListCard } from '@/components/kit/DataTable';
import { Avatar, inputCls } from '@/components/kit/ui';

type Row = { id: string; email: string; name: string | null; role: string; createdAt: string };
const ROLES = ['founder', 'admin', 'member'] as const;

export default function MembersSettings() {
  const { preview } = useNotify();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/founder/users');
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    const data = (await res.json()) as { users?: Row[] };
    setRows(data.users ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setRole(id: string, role: string) {
    setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, role } : r)) ?? prev);
    const res = await fetch('/api/founder/users', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: id, role }),
    });
    if (!res.ok) {
      preview('Could not update the role');
      void load();
    }
  }

  if (forbidden) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Members" description="Who is in this workspace and their role." />
        <ListCard>
          <p className="p-6 text-sm text-stone-500">Only founders can manage members.</p>
        </ListCard>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Members"
        description={rows ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}` : 'Loading…'}
      />
      <ListCard>
        <DataTable
          ariaLabel="Members"
          rows={rows ?? []}
          rowKey={(m) => m.id}
          columns={[
            {
              key: 'n',
              header: 'Member',
              render: (m) => (
                <span className="flex items-center gap-2.5">
                  <Avatar name={m.name || m.email} />
                  <span>
                    <span className="block font-medium text-stone-900">{m.name || '—'}</span>
                    <span className="block text-xs text-stone-500">{m.email}</span>
                  </span>
                </span>
              ),
            },
            {
              key: 'r',
              header: 'Role',
              render: (m) => (
                <select
                  aria-label={`Role for ${m.email}`}
                  className={inputCls}
                  value={m.role}
                  onChange={(e) => setRole(m.id, e.target.value)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ),
            },
            {
              key: 'j',
              header: 'Joined',
              align: 'right',
              render: (m) => (
                <span className="text-stone-500">{new Date(m.createdAt).toLocaleDateString()}</span>
              ),
            },
          ]}
        />
      </ListCard>
    </>
  );
}
