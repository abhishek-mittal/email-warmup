'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

/**
 * Shown on the inbox detail page when a `ready` inbox has no one to warm with
 * (warmupEligibility.canStart === false). Offers both paths to get partners:
 * join the shared pool, or add private warming inboxes.
 */
export function WarmupStartPrompt({ inboxId }: { inboxId: string }) {
  const api = useApi();
  const router = useRouter();
  const { toast, show, clear } = useToasts();
  const [busy, setBusy] = useState(false);

  async function joinPool() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/inboxes/${inboxId}/pool-consent`, {
        method: 'POST',
        body: JSON.stringify({ granted: true }),
      });
      show('Joined the shared pool. You can start warmup once a partner is available.', 'success');
      router.refresh();
    } catch (e) {
      show(e instanceof ApiError ? e.body : 'Could not join the shared pool', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
      <p className="font-medium">No inboxes to warm with yet</p>
      <p className="mt-1 text-sky-800">
        Warmup needs at least one other inbox to exchange mail with. Join the shared pool to warm
        against other senders, or add your own warming inboxes.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={joinPool}
          disabled={busy}
          className="rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Joining…' : 'Join shared pool'}
        </button>
        <Link
          href="/pool"
          className="rounded-full border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50"
        >
          Add warming inboxes
        </Link>
      </div>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </div>
  );
}
