'use client';

import { useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { PulseDot, type PulseState } from '@/components/PulseDot';
import { Toast, useToasts } from '@/components/Toast';

interface Props {
  poolInboxId: string;
  /** Stop the row-click (which opens the detail panel) from also firing. */
  onReanalyzed?: () => void;
}

/**
 * Triggers a fresh DNS analysis for one pool inbox by POSTing to
 * `POST /pool-inboxes/:id/analyze`. The endpoint enqueues an
 * `inbox-analysis` BullMQ job and returns immediately (the actual
 * analysis takes a few seconds).
 *
 * While the request is in flight, the inline `<PulseDot />` next to
 * the button label shows a sky-blue "busy" pulse. On success, it
 * flashes emerald-green ("live") for ~1.5s before fading out. On
 * failure, the dot goes rose-red and the toast shows the server's
 * error message.
 */
export function ReanalyzeButton({ poolInboxId, onReanalyzed }: Props) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState<PulseState>('idle');
  const { toast, show, clear } = useToasts();

  async function reanalyze(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    setPulse('busy');
    try {
      await api(`/pool-inboxes/${poolInboxId}/analyze`, { method: 'POST' });
      setPulse('live');
      show('Analysis re-queued — DNS results will refresh in a few seconds.', 'success');
      onReanalyzed?.();
      // Fade the dot back to idle after the success flash.
      setTimeout(() => setPulse('idle'), 1500);
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to re-analyze';
      setPulse('error');
      show(typeof msg === 'string' ? msg : 'Failed to re-analyze', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span
        className="inline-flex items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={reanalyze}
          disabled={busy}
          title="Re-run the DNS analysis (SPF, DKIM, DMARC, MX, rDNS)"
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PulseDot state={pulse} size="xs" label={pulse === 'busy' ? 'Re-analyzing…' : pulse === 'live' ? 'Analysis queued' : undefined} />
          {busy ? 'Re-analyzing…' : 'Re-analyze'}
        </button>
      </span>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
