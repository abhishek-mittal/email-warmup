'use client';

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { InboxStatusBadge } from '@/components/InboxStatusBadge';
import type { PoolPairingsResponse } from '@/lib/pool-activity-types';

interface Props {
  poolInboxId: string;
}

export function PoolPairingsTab({ poolInboxId }: Props) {
  const api = useApi();
  const [data, setData] = useState<PoolPairingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<PoolPairingsResponse>(`/pool-inboxes/${poolInboxId}/pairings`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load pairings');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, poolInboxId]);

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">
            Currently serving {data?.activePairs ?? 0} inboxes
          </h2>
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Each row is an inbox being warmed that this pool inbox is paired with — the pool
          inbox receives and acts on warmup emails from that inbox.
        </p>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="mt-6 text-sm text-stone-500">Loading pairings…</p>
        ) : !data || data.pairings.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
            Not currently paired with any inboxes. Pairing happens automatically when warmed
            inboxes run their daily send schedule.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-stone-200 text-sm">
              <thead className="text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="py-2 pr-4 text-left font-medium">Inbox</th>
                  <th className="py-2 pr-4 text-left font-medium">Provider</th>
                  <th className="py-2 pr-4 text-left font-medium">Day</th>
                  <th className="py-2 pr-4 text-left font-medium">Emails sent</th>
                  <th className="py-2 pr-4 text-left font-medium">Last send</th>
                  <th className="py-2 pr-4 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.pairings.map((p) => (
                  <tr key={p.inboxId}>
                    <td className="py-2 pr-4 font-mono text-xs text-stone-800">{p.inboxEmail}</td>
                    <td className="py-2 pr-4 capitalize text-stone-600">{p.inboxProvider}</td>
                    <td className="py-2 pr-4 text-stone-600">{p.warmupDay}</td>
                    <td className="py-2 pr-4 text-stone-600">{p.emailsSent}</td>
                    <td className="py-2 pr-4 text-stone-600">
                      {p.lastSendAt ? formatDateTime(p.lastSendAt) : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      <InboxStatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}