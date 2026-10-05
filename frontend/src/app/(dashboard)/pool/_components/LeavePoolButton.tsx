'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

interface Props {
  /** The owning inbox's id (not a pool_inboxes id). */
  inboxId: string;
  email: string;
  onLeft?: () => void;
}

/**
 * Removes one of the user's OWN consented inboxes from the shared pool,
 * straight from the Warming Pool grid. Hits the same endpoint as the toggle
 * on the inbox detail page (`POST /inboxes/:id/pool-consent` with
 * `granted: false`), which nulls `poolConsentAt` and deactivates the
 * `pool_members` row — so the row drops off this list on refresh.
 *
 * Owned rows deliberately do NOT get the dedicated-pool "Remove" (soft
 * delete) or "Reanalyze" actions: those operate on `pool_inboxes` and would
 * 404 against an inbox id.
 */
export function LeavePoolButton({ inboxId, email, onLeft }: Props) {
  const api = useApi();
  const router = useRouter();
  const { toast, show, clear } = useToasts();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function leave(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await api(`/inboxes/${inboxId}/pool-consent`, {
        method: 'POST',
        body: JSON.stringify({ granted: false }),
      });
      show('This inbox has left the shared pool.', 'success');
      onLeft?.();
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to leave the shared pool';
      show(msg || 'Failed to leave the shared pool', 'error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-stone-600">Leave pool for {email}?</span>
        <button
          type="button"
          onClick={leave}
          disabled={busy}
          className="rounded-full bg-rose-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
        >
          {busy ? 'Leaving…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          disabled={busy}
          className="rounded-full border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(true);
        }}
        className="rounded-full border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50"
      >
        Leave pool
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
