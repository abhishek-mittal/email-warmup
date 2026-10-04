'use client';

import Link from 'next/link';
import { useShellSummary } from './ShellData';

/**
 * Always-visible pulse of the account at the top of the sidebar: how many
 * inboxes are warming, how many need the owner. When the service cannot be
 * reached it says so instead of showing zeroes.
 */
export function LiveStatusCard() {
  const s = useShellSummary();

  if (s.state === 'error') {
    return (
      <div role="status" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
        <p className="eyebrow flex items-center gap-1.5 !text-rose-700">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden /> Offline
        </p>
        <p className="mt-1 text-xs text-rose-800">Can’t reach the service. Retrying.</p>
      </div>
    );
  }

  if (s.state === 'loading') {
    return (
      <div className="rounded-xl border border-stone-200 bg-white px-3 py-2.5" aria-hidden>
        <div className="h-3 w-12 rounded bg-stone-100" />
        <div className="mt-2 h-6 w-20 rounded bg-stone-100" />
        <div className="mt-2 h-1.5 w-full rounded bg-stone-100" />
      </div>
    );
  }

  if (s.total === 0) {
    return (
      <Link
        href="/inboxes/connect"
        className="block rounded-xl border border-dashed border-stone-300 bg-white px-3 py-2.5 transition-colors hover:border-brand-300 hover:bg-brand-50/40"
      >
        <p className="eyebrow">Get started</p>
        <p className="mt-1 text-[13px] font-medium text-stone-800">Connect your first inbox</p>
        <p className="text-xs text-stone-500">Warming begins as soon as it passes the check.</p>
      </Link>
    );
  }

  const pct = (n: number) => `${(n / s.total) * 100}%`;
  return (
    <div className="rounded-xl border border-stone-200 bg-white px-3 py-2.5">
      <p className="eyebrow flex items-center gap-1.5">
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        Live
      </p>
      <p className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold leading-none tabular-nums text-stone-900">{s.total}</span>
        <span className="text-xs text-stone-500">{s.total === 1 ? 'inbox' : 'inboxes'}</span>
      </p>
      <div
        className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-stone-100"
        role="img"
        aria-label={`${s.active} warming, ${s.paused} paused, ${s.attention} need attention`}
      >
        <span className="bg-emerald-500" style={{ width: pct(s.active) }} />
        <span className="bg-amber-400" style={{ width: pct(s.paused) }} />
        <span className="bg-rose-500" style={{ width: pct(s.attention) }} />
      </div>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-stone-500">Warming</dt>
        <dd className="text-right font-medium tabular-nums text-emerald-700">{s.active}</dd>
        {s.paused > 0 ? (
          <>
            <dt className="text-stone-500">Paused</dt>
            <dd className="text-right font-medium tabular-nums text-amber-700">{s.paused}</dd>
          </>
        ) : null}
        {s.attention > 0 ? (
          <>
            <dt className="text-stone-500">Need attention</dt>
            <dd className="text-right font-medium tabular-nums text-rose-700">{s.attention}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
