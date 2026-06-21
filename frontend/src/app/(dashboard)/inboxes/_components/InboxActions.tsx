'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

interface Props {
  inboxId: string;
  status: string;
}

export function InboxActions({ inboxId }: Props) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const { toast, show, clear } = useToasts();

  async function runPlacement() {
    setBusy('placement');
    try {
      await api(`/inboxes/${inboxId}/placement-test`, { method: 'POST' });
      show('Placement test started — results in ~5 minutes.', 'success');
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to start placement test';
      show(msg || 'Failed to start placement test', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={runPlacement}
        disabled={busy === 'placement'}
        className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50"
      >
        {busy === 'placement' ? 'Running…' : 'Run placement'}
      </button>
      <Link
        href={`/inboxes/${inboxId}`}
        className="rounded-full bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
      >
        View
      </Link>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </div>
  );
}
