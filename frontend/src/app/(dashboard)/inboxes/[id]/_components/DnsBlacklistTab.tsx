'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';
import { PulseDot } from '@/components/PulseDot';
import { formatDateTime } from '@/lib/format';
import type { BlacklistCheckHistoryRow, DnsCheckHistoryRow } from '@/lib/activity-types';

interface Props {
  inboxId: string;
}

/**
 * Two side-by-side cards: DNS check status grid + history on the
 * left, blacklist verdict + RBL drill-down on the right. Stacks on
 * mobile.
 *
 * Each card has a "Run … Check Now" button that POSTs to
 * `/inboxes/:id/checks/{dns,blacklist}` to enqueue an immediate job.
 * The existing daily cron continues to run — manual enqueue is just
 * an extra trigger.
 */
export function DnsBlacklistTab({ inboxId }: Props) {
  const api = useApi();
  const [dns, setDns] = useState<DnsCheckHistoryRow[]>([]);
  const [blacklist, setBlacklist] = useState<BlacklistCheckHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dnsBusy, setDnsBusy] = useState(false);
  const [blacklistBusy, setBlacklistBusy] = useState(false);

  const { toast, show, clear } = useToasts();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dnsRows, blacklistRows] = await Promise.all([
        api<DnsCheckHistoryRow[]>(`/inboxes/${inboxId}/dns-history?limit=5`),
        api<BlacklistCheckHistoryRow[]>(`/inboxes/${inboxId}/blacklist-history?limit=5`),
      ]);
      setDns(dnsRows);
      setBlacklist(blacklistRows);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.body : err instanceof Error ? err.message : 'Failed to load check history';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [api, inboxId]);

  useEffect(() => {
    // Initial fetch and re-fetch when `refresh` changes (stable thanks
    // to `useCallback`). All state setters live inside `refresh` itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function runCheck(kind: 'dns' | 'blacklist') {
    if (kind === 'dns') {
      setDnsBusy(true);
    } else {
      setBlacklistBusy(true);
    }
    try {
      await api(`/inboxes/${inboxId}/checks/${kind}`, { method: 'POST' });
      show(`${kind === 'dns' ? 'DNS' : 'Blacklist'} check queued`, 'success');
      // Wait briefly for the worker to insert a new row, then refresh.
      setTimeout(() => {
        void refresh();
      }, 2500);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.body : err instanceof Error ? err.message : 'Failed to enqueue check';
      show(msg, 'error');
    } finally {
      if (kind === 'dns') setDnsBusy(false);
      else setBlacklistBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <DnsCard dns={dns} loading={loading} busy={dnsBusy} onRun={() => runCheck('dns')} />

      <BlacklistCard
        blacklist={blacklist}
        loading={loading}
        busy={blacklistBusy}
        onRun={() => runCheck('blacklist')}
      />

      {error ? (
        <p className="sm:col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </div>
  );
}

interface DnsCardProps {
  dns: DnsCheckHistoryRow[];
  loading: boolean;
  busy: boolean;
  onRun: () => void;
}

function DnsCard({ dns, loading, busy, onRun }: DnsCardProps) {
  const latest = dns[0] ?? null;

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-700">DNS</h2>
          <p className="text-xs text-stone-500">
            {latest ? `Last checked ${formatDateTime(latest.checkedAt)}` : 'No DNS checks yet'}
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <PulseDot state="busy" size="xs" />
              Queuing…
            </>
          ) : (
            'Run DNS Check Now'
          )}
        </button>
      </header>

      {loading && !latest ? (
        <p className="mt-4 text-sm text-stone-500">Loading…</p>
      ) : latest ? (
        <div className="mt-4 space-y-2">
          <DnsRow label="SPF" status={latest.spfValid} detail={null} />
          <DnsRow label="DKIM" status={latest.dkimValid} detail={null} />
          <DnsRow label="DMARC" status={latest.dmarcValid} detail={null} />
          <DnsRow label="MX" status={latest.mxValid} detail={null} />
          <DnsRow label="rDNS" status={latest.rdnsValid} detail={null} />
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone-500">No DNS checks yet. Click &ldquo;Run DNS Check Now&rdquo; to start.</p>
      )}

      {dns.length > 1 ? (
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">History</h3>
          <ul className="mt-2 divide-y divide-stone-100 text-sm">
            {dns.slice(1).map((row) => (
              <li key={row.id} className="flex items-center justify-between py-2">
                <span className="text-stone-700">{formatDateTime(row.checkedAt)}</span>
                <span className="text-stone-500">
                  Score {typeof row.score === 'number' ? row.score : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function DnsRow({ label, status, detail }: { label: string; status: boolean | null; detail: string | null }) {
  const color =
    status === null
      ? 'bg-stone-100 text-stone-600'
      : status
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-rose-100 text-rose-700';
  const mark =
    status === null ? '–' : status ? '✓' : '✗';
  return (
    <div className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm">
      <span className="font-medium text-stone-700">{label}</span>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
        {mark} {status === null ? 'Unknown' : status ? 'Valid' : 'Invalid'}
      </span>
      {detail ? <span className="text-xs text-stone-500">{detail}</span> : null}
    </div>
  );
}

interface BlacklistCardProps {
  blacklist: BlacklistCheckHistoryRow[];
  loading: boolean;
  busy: boolean;
  onRun: () => void;
}

function BlacklistCard({ blacklist, loading, busy, onRun }: BlacklistCardProps) {
  const latest = blacklist[0] ?? null;
  const isClean = latest?.isClean ?? null;
  const listedCount = latest?.listedCount ?? 0;

  const verdictColor =
    isClean === null
      ? 'text-stone-400'
      : isClean
      ? 'text-emerald-600'
      : 'text-rose-600';
  const verdictLabel =
    isClean === null
      ? latest
        ? 'Could not be checked'
        : 'Not yet checked'
      : isClean
      ? '✓ Clean'
      : listedCount > 0
      ? `⚠ Listed on ${listedCount} RBL${listedCount === 1 ? '' : 's'}`
      : '⚠ Listed';

  const listedRbls = latest?.rblResults
    ? Object.entries(latest.rblResults).filter(([, status]) => status === 'listed').map(([zone]) => zone)
    : [];
  // How many lists actually answered. A list that refused the query, timed
  // out, or needs a sending IP we don't have tells us nothing either way.
  const rblStatuses = latest?.rblResults ? Object.values(latest.rblResults) : [];
  const answeredCount = rblStatuses.filter((status) => status === 'clean' || status === 'listed').length;
  const unansweredCount = rblStatuses.length - answeredCount;

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-700">Blacklist</h2>
          <p className="text-xs text-stone-500">
            {latest ? `Last checked ${formatDateTime(latest.checkedAt)}` : 'No blacklist checks yet'}
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <PulseDot state="busy" size="xs" />
              Queuing…
            </>
          ) : (
            'Run Blacklist Check Now'
          )}
        </button>
      </header>

      {loading && !latest ? (
        <p className="mt-4 text-sm text-stone-500">Loading…</p>
      ) : latest ? (
        <div className="mt-4 space-y-3">
          <p className={`text-base font-semibold ${verdictColor}`}>{verdictLabel}</p>
          <p className="text-xs text-stone-500">
            {answeredCount} of {rblStatuses.length} lists answered.
            {unansweredCount > 0
              ? ` ${unansweredCount} gave no result (query refused, timed out, list retired, or it needs a sending IP that isn’t set for this inbox). No result is not the same as clean.`
              : ''}
          </p>
          {listedRbls.length > 0 ? (
            <details className="rounded-lg border border-rose-100 bg-rose-50/50 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-rose-700">
                Show listed RBLs ({listedRbls.length})
              </summary>
              <ul className="mt-2 list-disc pl-5 text-xs text-rose-700">
                {listedRbls.map((zone) => (
                  <li key={zone} className="font-mono">{zone}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone-500">
          No blacklist checks yet. Click &ldquo;Run Blacklist Check Now&rdquo; to start.
        </p>
      )}

      {blacklist.length > 1 ? (
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">History</h3>
          <ul className="mt-2 divide-y divide-stone-100 text-sm">
            {blacklist.slice(1).map((row) => (
              <li key={row.id} className="flex items-center justify-between py-2">
                <span className="text-stone-700">{formatDateTime(row.checkedAt)}</span>
                <span className={row.isClean ? 'text-emerald-600' : 'text-rose-600'}>
                  {row.isClean ? 'Clean' : `Listed (${row.listedCount ?? '?'})`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}