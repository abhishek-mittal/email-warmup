'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

interface Props {
  inboxId: string;
  canRun: boolean;
}

export function RequestAnalysisButton({ inboxId, canRun }: Props) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { toast, show, clear } = useToasts();

  if (!canRun) {
    return (
      <div className="text-xs text-stone-500">
        <span className="font-medium text-stone-700">Upgrade required.</span> AI analysis is
        available on the Growth plan and above.
      </div>
    );
  }

  async function run() {
    setBusy(true);
    try {
      await api(`/inboxes/${inboxId}/diagnostics/run`, { method: 'POST' });
      show('Analysis requested. Reload in a few seconds.', 'success');
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to request analysis';
      show(msg || 'Failed to request analysis', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? 'Requesting…' : 'Request new analysis'}
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
