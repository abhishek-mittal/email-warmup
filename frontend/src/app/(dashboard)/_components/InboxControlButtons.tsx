'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';
import { PulseDot } from '@/components/PulseDot';

interface Props {
  inboxId: string;
  status: string;
  /** Visual size — `sm` (table row) or `md` (page header). */
  size?: 'sm' | 'md';
  /**
   * Called after a successful pause/resume so the parent can refresh
   * any server-rendered data (e.g. router.refresh() in a Server
   * Component tree). If omitted, callers are expected to handle
   * their own refresh.
   */
  onChanged?: (newStatus: string) => void;
}

interface ControlResult {
  id: string;
  status: string;
}

/**
 * Pause / Resume toggle button for a single inbox. Status-aware:
 *  - 'active'    → show Pause
 *  - 'paused'    → show Resume
 *  - 'pending'   → show Pause (no-op; user just connected)
 *  - 'graduated' → hide entirely (warmup is done)
 *  - 'error'     → show Pause (most likely they want to stop sending)
 *
 * Bulk operations live in `BulkInboxActions` (separate component) so
 * this stays small. Both share the same toast + refresh flow.
 */
export function InboxControlButtons({ inboxId, status, size = 'sm', onChanged }: Props) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { toast, show, clear } = useToasts();

  if (status === 'graduated') {
    // Warmup is done — no need to surface a control. Render an inert
    // "Graduated" pill so the row's action column isn't empty.
    return size === 'md' ? (
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700">
        Graduated
      </span>
    ) : null;
  }

  const isPaused = status === 'paused';
  const action = isPaused ? 'resume' : 'pause';

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api<ControlResult>(`/inboxes/${inboxId}/${action}`, { method: 'POST' });
      const label = isPaused ? 'Resumed' : 'Paused';
      show(`${label} warmup for this inbox.`, 'success');
      if (onChanged) {
        onChanged(res.status);
      } else {
        router.refresh();
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : e instanceof Error ? e.message : `Failed to ${action}`;
      show(msg || `Failed to ${action}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const padding = size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';
  const baseClasses = `inline-flex items-center gap-1.5 rounded-full font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${padding}`;

  if (isPaused) {
    return (
      <>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          title="Resume warmup — schedule today's sends immediately"
          className={`${baseClasses} bg-emerald-600 text-white hover:bg-emerald-700`}
        >
          {busy ? <PulseDot state="busy" size="xs" /> : null}
          {busy ? 'Resuming…' : 'Resume'}
        </button>
        {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        title="Pause warmup — drain pending send/receive jobs and set status to paused"
        className={`${baseClasses} border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100`}
      >
        {busy ? <PulseDot state="busy" size="xs" /> : null}
        {busy ? 'Pausing…' : 'Pause'}
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}