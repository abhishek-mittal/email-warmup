'use client';

import { useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';
import type { Plan } from '@/lib/types';

export function CheckoutButton({ plan }: { plan: Plan }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const { toast, show, clear } = useToasts();

  async function go() {
    setBusy(true);
    try {
      const res = await api<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      window.location.href = res.url;
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to start checkout';
      show(msg || 'Failed to start checkout', 'error');
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex w-full items-center justify-center rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? 'Redirecting…' : `Upgrade to ${plan}`}
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}

export function PortalButton() {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const { toast, show, clear } = useToasts();

  async function go() {
    setBusy(true);
    try {
      const res = await api<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = res.url;
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to open portal';
      show(msg || 'Failed to open portal', 'error');
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center justify-center rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? 'Opening…' : 'Manage subscription'}
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
