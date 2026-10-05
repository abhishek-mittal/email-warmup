'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

interface Props {
  poolInboxId: string;
  email: string;
  /** Stop the row-click (which opens the detail panel) from also firing. */
  onRemoved?: () => void;
}

export function RemovePoolInboxButton({ poolInboxId, email, onRemoved }: Props) {
  const api = useApi();
  const router = useRouter();
  const { toast, show, clear } = useToasts();
  const [busy, setBusy] = useState(false);
  // In-page confirm step instead of window.confirm() — native dialogs block
  // the whole page (and any automated browser testing of this flow).
  const [confirming, setConfirming] = useState(false);

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await api(`/pool-inboxes/${poolInboxId}`, { method: 'DELETE' });
      show('Removed from pool.', 'success');
      onRemoved?.();
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to remove pool inbox';
      show(msg || 'Failed to remove pool inbox', 'error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-stone-600">Remove {email}?</span>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="rounded-full bg-rose-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
        >
          {busy ? 'Removing…' : 'Confirm'}
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
        Remove
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
