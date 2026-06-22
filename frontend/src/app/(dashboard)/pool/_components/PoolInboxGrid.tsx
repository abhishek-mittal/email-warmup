'use client';

import { useState } from 'react';
import { poolInboxStatusColor } from '@/lib/plan-config';
import { formatDate } from '@/lib/format';
import type { PoolInbox } from '@/lib/types';
import { HealthChip, IssuesCell } from '@/app/(dashboard)/_components/AnalysisCells';
import { RemovePoolInboxButton } from './RemovePoolInboxButton';
import { PoolInboxDetailPanel } from './PoolInboxDetailPanel';

export function PoolInboxGrid({ poolInboxes }: { poolInboxes: PoolInbox[] }) {
  const [selected, setSelected] = useState<PoolInbox | null>(null);

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">DNS Health</th>
              <th className="px-4 py-3">Issues</th>
              <th className="px-4 py-3 text-right">Active Pairs</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Added</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {poolInboxes.map((p) => {
              const status = poolInboxStatusColor(p.status);
              return (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-4 py-3 font-medium text-slate-900">{p.email}</td>
                  <td className="px-4 py-3 capitalize text-slate-600">{p.provider}</td>
                  <td className="px-4 py-3">
                    <HealthChip analysis={p.analysis} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <IssuesCell analysis={p.analysis} status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{p.activePairs}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.bg} ${status.text}`}
                    >
                      {status.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(p.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <RemovePoolInboxButton poolInboxId={p.id} email={p.email} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected ? (
        <PoolInboxDetailPanel poolInbox={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  );
}
