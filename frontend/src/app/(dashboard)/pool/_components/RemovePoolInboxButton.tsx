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

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Remove ${email} from the warming pool?`)) return;
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
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="rounded-full border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
      >
        {busy ? 'Removing…' : 'Remove'}
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
