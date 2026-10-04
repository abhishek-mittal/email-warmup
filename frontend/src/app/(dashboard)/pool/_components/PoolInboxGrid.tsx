'use client';

import { useRouter } from 'next/navigation';
import { poolInboxStatusColor } from '@/lib/plan-config';
import { formatDate } from '@/lib/format';
import type { PoolInbox } from '@/lib/types';
import { HealthChip, IssuesCell } from '@/app/(dashboard)/_components/AnalysisCells';
import { PulseDot, type PulseState } from '@/components/PulseDot';
import { RemovePoolInboxButton } from './RemovePoolInboxButton';
import { ReanalyzeButton } from './ReanalyzeButton';
import { ReadinessBadge } from './ReadinessBadge';
import { LeavePoolButton } from './LeavePoolButton';

interface Props {
  poolInboxes: PoolInbox[];
  /**
   * If true, the page is currently polling the backend (e.g. after a
   * CSV / wizard upload). Drives the small "Refreshing" indicator
   * at the top of the grid — `idle` when no poll is running, `busy`
   * when one is, `live` briefly on each successful response, `error`
   * if a poll fails.
   */
  pollState?: PulseState;
}

export function PoolInboxGrid({ poolInboxes, pollState = 'idle' }: Props) {
  const router = useRouter();

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <PulseDot
            state={pollState}
            label={
              pollState === 'busy' ? 'Refreshing analysis…' :
              pollState === 'live' ? 'Analysis updated' :
              pollState === 'error' ? 'Refresh failed' : 'Live'
            }
          />
          {pollState === 'busy' ? <span>Refreshing analysis…</span> :
           pollState === 'live' ? <span>Updated just now</span> :
           pollState === 'error' ? <span>Last refresh failed</span> : null}
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-stone-200 text-sm">
          <thead className="bg-stone-50 text-left text-xs font-medium uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">DNS Health</th>
              <th className="px-4 py-3">Issues</th>
              <th className="px-4 py-3 text-right">Active Pairs</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Added</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {poolInboxes.map((p) => {
              const status = poolInboxStatusColor(p.status);
              const owned = p.source === 'owned';
              // Owned rows are the user's own inboxes — their detail lives at
              // /inboxes/:id. Dedicated pool_inboxes open the pool detail page.
              const href = owned ? `/inboxes/${p.id}` : `/pool/${p.id}`;
              return (
                <tr
                  key={`${p.source}-${p.id}`}
                  onClick={() => router.push(href)}
                  className="cursor-pointer hover:bg-stone-50"
                >
                  <td className="px-4 py-3 font-medium text-stone-900">{p.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        owned
                          ? 'bg-sky-100 text-sky-700'
                          : 'bg-violet-100 text-violet-700'
                      }`}
                    >
                      {owned ? 'Owned' : 'Dedicated'}
                    </span>
                  </td>
                  <td className="px-4 py-3 capitalize text-stone-600">{p.provider}</td>
                  <td className="px-4 py-3">
                    <HealthChip analysis={p.analysis} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <IssuesCell analysis={p.analysis} status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{p.activePairs}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.bg} ${status.text}`}
                      >
                        {status.label}
                      </span>
                      <ReadinessBadge status={p.status} analysis={p.analysis} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-stone-600">{formatDate(p.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div
                      className="inline-flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {owned ? (
                        <LeavePoolButton inboxId={p.id} email={p.email} />
                      ) : (
                        <>
                          <ReanalyzeButton poolInboxId={p.id} />
                          <RemovePoolInboxButton poolInboxId={p.id} email={p.email} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </>
  );
}
