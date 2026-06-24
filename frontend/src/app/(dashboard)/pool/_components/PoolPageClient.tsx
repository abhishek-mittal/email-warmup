'use client';

import { useCallback, useState } from 'react';
import { useApi } from '@/lib/api';
import { PulseDot, type PulseState } from '@/components/PulseDot';
import { BatchUploadCsv } from '@/app/(dashboard)/_components/BatchUploadCsv';
import { BatchUploadWizard } from '@/app/(dashboard)/_components/BatchUploadWizard';
import type { PoolInbox } from '@/lib/types';
import { PoolInboxGrid } from './PoolInboxGrid';

interface Props {
  initial: PoolInbox[];
}

/**
 * Client wrapper for `/pool`. Owns the page's polling state: when a
 * wizard / CSV upload succeeds, the upload component calls
 * `onUploaded` (passed through here) and this component fetches
 * `/pool-inboxes` every 2s until every row has an `analysis` (or
 * 30 attempts — 60s — have passed).
 *
 * Why a client component: the data fetch is on the same endpoint the
 * server component would have re-fetched via `router.refresh()`, but
 * `router.refresh()` re-runs the Server Component exactly once, not
 * on an interval. SWR is the conventional answer here, but a small
 * `useState` + `setInterval` is enough for this case and avoids
 * adding the SWR import to a page that doesn't otherwise need it.
 */
export function PoolPageClient({ initial }: Props) {
  const api = useApi();
  const [pollState, setPollState] = useState<PulseState>('idle');
  const [rows, setRows] = useState<PoolInbox[]>(initial);
  const [pollError, setPollError] = useState<string | null>(null);

  const startPolling = useCallback(() => {
    setPollError(null);
    let attempts = 0;
    const maxAttempts = 30; // 60s at 2s/attempt

    setPollState('busy');

    const tick = async () => {
      attempts += 1;
      try {
        const fresh = await api<PoolInbox[]>('/pool-inboxes');
        setRows(fresh);
        const allHaveAnalysis = fresh.length > 0 && fresh.every((r) => r.analysis !== null);
        if (allHaveAnalysis) {
          setPollState('live');
          // Brief flash, then idle.
          setTimeout(() => setPollState('idle'), 1500);
          return;
        }
        if (attempts >= maxAttempts) {
          setPollState('error');
          setPollError('Analysis did not finish within 60 seconds. Try re-analyzing the row.');
          return;
        }
        setTimeout(tick, 2000);
      } catch (err) {
        setPollState('error');
        setPollError(err instanceof Error ? err.message : 'Failed to refresh analysis.');
      }
    };

    // Start the first poll immediately, no delay.
    void tick();
  }, [api]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900">Warming Pool</h1>
          <p className="text-sm text-slate-600">
            Inboxes dedicated to peer-to-peer warmup traffic for your account.
            Click a row to see DNS health and how to fix issues.
          </p>
          {pollError ? (
            <p className="flex items-center gap-1.5 text-xs text-rose-600">
              <PulseDot state="error" size="xs" label={pollError} />
              {pollError}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <BatchUploadCsv endpoint="/pool-inboxes/batch/csv" onUploaded={startPolling} />
          <BatchUploadWizard endpoint="/pool-inboxes/batch" onUploaded={startPolling} />
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <p className="text-sm text-slate-600">
            No pool inboxes yet. Add pool inboxes to enable warming.
          </p>
          <p className="text-xs text-slate-500">
            Use the “Add via CSV” or “Add via wizard” buttons (top right).
          </p>
        </div>
      ) : (
        <PoolInboxGrid poolInboxes={rows} pollState={pollState} />
      )}
    </div>
  );
}
