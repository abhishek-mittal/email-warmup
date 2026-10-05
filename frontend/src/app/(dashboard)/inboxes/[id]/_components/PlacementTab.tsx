'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { PlacementHistoryRow } from '@/lib/activity-types';
import { RunPlacementButton } from './RunPlacementButton';

interface Props {
  inboxId: string;
}

/**
 * "Placement" tab — shows the most recent placement test as a stacked
 * bar (Primary / Promotions / Spam / Missing) and lists every prior
 * test in a small table. Includes the existing "Run Placement Test"
 * button so users can trigger a new test from this tab without
 * having to scroll back to the top.
 */
export function PlacementTab({ inboxId }: Props) {
  const api = useApi();
  const [rows, setRows] = useState<PlacementHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<PlacementHistoryRow[]>(`/inboxes/${inboxId}/placement-history`);
      setRows(data);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.body : err instanceof Error ? err.message : 'Failed to load placement history';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [api, inboxId]);

  useEffect(() => {
    // Initial fetch and re-fetch when `refresh` changes (it doesn't —
    // it's stable thanks to `useCallback` — but listing it keeps the
    // linter from flagging an exhaustive-deps issue).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const latest = rows[0] ?? null;

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-stone-700">Most recent placement</h2>
            <p className="text-xs text-stone-500">
              {latest ? `Completed ${formatDateTime(latest.completedAt)}` : 'No placement tests yet'}
            </p>
          </div>
          <RunPlacementButton inboxId={inboxId} disabled={false} />
        </header>

        {loading && !latest ? (
          <p className="mt-6 text-sm text-stone-500">Loading…</p>
        ) : latest && latest.status === 'failed' ? (
          <div
            role="status"
            className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-medium">This test did not produce a result.</p>
            <p className="mt-1">
              {latest.failureReason ?? 'Too few seed mailboxes could be checked.'} This says nothing
              about your inbox, and the test was not counted against your allowance.
            </p>
          </div>
        ) : latest ? (
          <PlacementBar
            primary={latest.primaryPct ?? 0}
            promotions={latest.promotionsPct ?? 0}
            spam={latest.spamPct ?? 0}
            missing={latest.missingPct ?? 0}
          />
        ) : (
          <p className="mt-6 text-sm text-stone-500">
            No placement tests run yet. Click &ldquo;Run Placement Test&rdquo; to start.
          </p>
        )}
        {latest && latest.status !== 'failed' ? (
          <p className="mt-4 text-xs text-stone-500">
            Based on {latest.observedCount ?? latest.seedCount ?? 0} of {latest.seedCount ?? 0} seed
            mailboxes.
            {latest.status === 'partial'
              ? ` ${latest.errorCount ?? 0} could not be checked and are left out of the percentages — they are not counted as spam or missing.`
              : ''}{' '}
            One generic test message was sent from this inbox; the result indicates sender standing
            and does not predict how a specific campaign will be placed.
          </p>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-stone-700">History</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-stone-200 text-left text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Seeds</th>
                  <th className="px-3 py-2">Primary</th>
                  <th className="px-3 py-2">Promotions</th>
                  <th className="px-3 py-2">Spam</th>
                  <th className="px-3 py-2">Missing</th>
                  <th className="px-3 py-2">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-stone-50">
                    <td className="whitespace-nowrap px-3 py-2 text-stone-700">{formatDateTime(row.completedAt)}</td>
                    <td className="px-3 py-2 text-stone-700">
                      {row.status === 'failed'
                        ? `0 of ${row.seedCount ?? '—'}`
                        : row.status === 'partial'
                          ? `${row.observedCount ?? '—'} of ${row.seedCount ?? '—'}`
                          : (row.seedCount ?? '—')}
                    </td>
                    {row.status === 'failed' ? (
                      <td colSpan={5} className="px-3 py-2 text-amber-800">
                        No result — seed mailboxes could not be checked
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-emerald-700">{pct(row.primaryPct)}</td>
                        <td className="px-3 py-2 text-amber-700">{pct(row.promotionsPct)}</td>
                        <td className="px-3 py-2 text-rose-700">{pct(row.spamPct)}</td>
                        <td className="px-3 py-2 text-stone-700">{pct(row.missingPct)}</td>
                        <td className="px-3 py-2 font-mono text-stone-700">{row.placementScore ?? '—'}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>
      ) : null}
    </section>
  );
}

/** A percentage cell: a dash when there is no figure, never "—%". */
function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}%`;
}

interface PlacementBarProps {
  primary: number;
  promotions: number;
  spam: number;
  missing: number;
}

function PlacementBar({ primary, promotions, spam, missing }: PlacementBarProps) {
  const total = Math.max(0, primary + promotions + spam + missing);
  const safeTotal = total > 0 ? total : 100;
  const seg = (n: number) => `${(n / safeTotal) * 100}%`;

  return (
    <div className="mt-6 space-y-4">
      <div className="flex h-6 w-full overflow-hidden rounded-full bg-stone-100">
        <div style={{ width: seg(primary), backgroundColor: '#10b981' }} title={`Primary ${primary}%`} />
        <div style={{ width: seg(promotions), backgroundColor: '#f59e0b' }} title={`Promotions ${promotions}%`} />
        <div style={{ width: seg(spam), backgroundColor: '#e11d48' }} title={`Spam ${spam}%`} />
        {missing > 0 ? (
          <div style={{ width: seg(missing), backgroundColor: '#a1a1aa' }} title={`Missing ${missing}%`} />
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <BarLegend label="Primary" value={primary} color="#10b981" />
        <BarLegend label="Promotions" value={promotions} color="#f59e0b" />
        <BarLegend label="Spam" value={spam} color="#e11d48" />
        {missing > 0 ? <BarLegend label="Missing" value={missing} color="#a1a1aa" /> : null}
      </div>
    </div>
  );
}

function BarLegend({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
      <span className="text-stone-600">{label}</span>
      <span className="ml-auto font-semibold text-stone-900">{value}%</span>
    </div>
  );
}