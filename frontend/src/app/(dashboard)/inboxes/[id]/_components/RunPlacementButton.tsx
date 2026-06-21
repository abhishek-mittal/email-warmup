'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

interface Props {
  inboxId: string;
  disabled: boolean;
  disabledReason?: string;
}

export function RunPlacementButton({ inboxId, disabled, disabledReason }: Props) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { toast, show, clear } = useToasts();

  async function run() {
    setBusy(true);
    try {
      await api(`/inboxes/${inboxId}/placement-test`, { method: 'POST' });
      show('Placement test started — results in ~5 minutes.', 'success');
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to start placement test';
      show(msg || 'Failed to start placement test', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        title={disabled ? disabledReason : undefined}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Running…' : 'Run Placement Test'}
      </button>
      {disabled && disabledReason ? (
        <p className="mt-2 text-xs text-rose-600">{disabledReason}</p>
      ) : null}
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </div>
  );
}
