'use client';

import { DnsStatusCard } from '@/components/DnsStatusCard';
import { formatDate } from '@/lib/format';
import type { PoolInbox } from '@/lib/types';
import { HealthScoreGauge } from './HealthScoreGauge';

interface Props {
  poolInbox: PoolInbox;
  onClose: () => void;
}

/**
 * Minimal slide-over panel — there's no existing modal/panel primitive
 * beyond `Toast`, so this is a small fixed-positioned overlay built just
 * for this detail view.
 */
export function PoolInboxDetailPanel({ poolInbox, onClose }: Props) {
  const analysis = poolInbox.analysis;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div className="relative h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{poolInbox.email}</h2>
            <p className="text-sm capitalize text-slate-600">{poolInbox.provider}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="mt-6 flex justify-center">
          <HealthScoreGauge score={analysis?.healthScore ?? null} />
        </div>

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-slate-900">DNS health breakdown</h3>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <DnsStatusCard type="spf" status={analysis?.spfValid ?? null} />
            <DnsStatusCard type="dkim" status={analysis?.dkimValid ?? null} />
            <DnsStatusCard type="dmarc" status={analysis?.dmarcValid ?? null} />
            <DnsStatusCard type="mx" status={analysis?.mxValid ?? null} />
            <DnsStatusCard type="rdns" status={analysis?.rdnsValid ?? null} />
          </div>
        </section>

        <section className="mt-6 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Active pairs
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{poolInbox.activePairs}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Date added
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900">
              {formatDate(poolInbox.createdAt)}
            </p>
          </div>
        </section>

        {!analysis ? (
          <p className="mt-6 text-sm text-slate-500">
            {poolInbox.status === 'pending'
              ? 'Analysing… DNS health will appear here once the analysis job finishes.'
              : 'No analysis available yet.'}
          </p>
        ) : null}
      </div>
    </div>
  );
}
