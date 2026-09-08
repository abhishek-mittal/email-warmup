'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { PulseDot } from '@/components/PulseDot';
import { formatDateTime } from '@/lib/format';
import type { SendsPage, WarmupSendRow } from '@/lib/activity-types';

interface Props {
  inboxId: string;
}

type StatusFilter = 'all' | 'opened' | 'replied' | 'rescued' | 'spam';
type DateRange = '7d' | '30d' | 'all';

const PAGE_SIZE = 25;

/**
 * "Sent Emails" tab — table of every warmup email sent from this inbox.
 * Columns:
 *   Date · To · Subject · Warmup Day · Opened · Replied · Starred ·
 *   Rescued · Spam · Tab
 *
 * Row expand shows full subject, message id, scheduled vs sent latency.
 * Filters: date range (7d/30d/all) and status (opened/replied/etc).
 * Pagination: 25 per page, prev/next.
 */
export function SentEmailsTab({ inboxId }: Props) {
  const api = useApi();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [range, setRange] = useState<DateRange>('30d');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [data, setData] = useState<SendsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(PAGE_SIZE));
      if (status !== 'all') params.set('status', status);
      const fromIso = rangeFromNow(range);
      if (fromIso) params.set('from', fromIso);

      const result = await api<SendsPage>(`/inboxes/${inboxId}/sends?${params.toString()}`);
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.body : err instanceof Error ? err.message : 'Failed to load sent emails';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [api, inboxId, page, range, status]);

  useEffect(() => {
    // Reset to page 1 whenever a filter changes — otherwise the user
    // could end up on page 5 of the previous filter with no rows in
    // the new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [status, range]);

  useEffect(() => {
    // Initial fetch and re-fetch when filters/page change. `fetchPage`
    // owns its own loading/data setters — we don't set any state here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPage();
  }, [fetchPage]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Sent Emails</h2>
          <p className="text-xs text-slate-500">
            {data ? `${data.total.toLocaleString()} email${data.total === 1 ? '' : 's'} sent from this inbox` : 'Loading…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPills
            label="Date"
            value={range}
            onChange={setRange}
            options={[
              { value: '7d', label: 'Last 7d' },
              { value: '30d', label: 'Last 30d' },
              { value: 'all', label: 'All time' },
            ]}
          />
          <FilterPills
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'opened', label: 'Opened' },
              { value: 'replied', label: 'Replied' },
              { value: 'rescued', label: 'Rescued' },
              { value: 'spam', label: 'Spam' },
            ]}
          />
        </div>
      </header>

      {error ? (
        <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Day</th>
              <th className="px-3 py-2">Opened</th>
              <th className="px-3 py-2">Replied</th>
              <th className="px-3 py-2">Starred</th>
              <th className="px-3 py-2">Rescued</th>
              <th className="px-3 py-2">Spam</th>
              <th className="px-3 py-2">Tab</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && !data ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-slate-500">
                  <span className="inline-flex items-center gap-2">
                    <PulseDot state="busy" size="xs" />
                    Loading sent emails…
                  </span>
                </td>
              </tr>
            ) : data && data.rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-slate-500">
                  No emails sent yet from this inbox.
                </td>
              </tr>
            ) : (
              data?.rows.map((row) => (
                <SentRow
                  key={row.id}
                  row={row}
                  expanded={expanded === row.id}
                  onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > 0 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <p className="text-xs text-slate-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function rangeFromNow(range: DateRange): string | null {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface FilterPillsProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}

function FilterPills<T extends string>({ label, value, onChange, options }: FilterPillsProps<T>) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 p-1 text-xs">
      <span className="px-2 text-slate-500">{label}:</span>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface SentRowProps {
  row: WarmupSendRow;
  expanded: boolean;
  onToggle: () => void;
}

function SentRow({ row, expanded, onToggle }: SentRowProps) {
  const subjectTruncated = row.subject
    ? row.subject.length > 60
      ? `${row.subject.slice(0, 59)}…`
      : row.subject
    : '—';

  const latency =
    row.sentAt && row.scheduledAt
      ? formatLatencyMs(new Date(row.sentAt).getTime() - new Date(row.scheduledAt).getTime())
      : null;

  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={onToggle}>
        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{row.sentAt ? formatDateTime(row.sentAt) : '—'}</td>
        <td className="max-w-[14rem] truncate px-3 py-2 text-slate-700" title={row.receiverEmail ?? ''}>
          {row.receiverEmail ?? '—'}
        </td>
        <td className="max-w-[18rem] truncate px-3 py-2 text-slate-700" title={row.subject ?? ''}>
          {subjectTruncated}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-slate-700">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">Day {row.warmupDay}</span>
        </td>
        <td className="px-3 py-2">
          <StatusCell timestamp={row.openedAt} />
        </td>
        <td className="px-3 py-2">
          <StatusCell timestamp={row.repliedAt} />
        </td>
        <td className="px-3 py-2">
          <StatusCell timestamp={row.starredAt} />
        </td>
        <td className="px-3 py-2">
          <StatusCell timestamp={row.rescuedAt} />
        </td>
        <td className="px-3 py-2">
          {row.landedInSpam ? (
            <span className="inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
              Spam
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          {row.landedInTab ? <TabChip tab={row.landedInTab} /> : <span className="text-slate-400">—</span>}
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-slate-50/60">
          <td colSpan={10} className="px-3 py-3">
            <div className="grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
              <DetailField label="Full subject" value={row.subject ?? '—'} />
              <DetailField label="Message ID" value={row.messageId ?? '—'} mono />
              <DetailField label="Scheduled at" value={formatDateTime(row.scheduledAt)} />
              <DetailField label="Sent at" value={row.sentAt ? formatDateTime(row.sentAt) : '—'} />
              {latency ? <DetailField label="Latency (scheduled → sent)" value={latency} /> : null}
              <DetailField label="Filed at" value={row.filedAt ? formatDateTime(row.filedAt) : '—'} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function StatusCell({ timestamp }: { timestamp: string | null }) {
  if (!timestamp) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-emerald-600" title={new Date(timestamp).toISOString()}>
      <span aria-hidden>✓</span>
      <span className="text-xs text-slate-500">{formatRelativeShort(timestamp)}</span>
    </span>
  );
}

function formatRelativeShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

function formatLatencyMs(ms: number): string {
  if (ms < 0) return `${Math.abs(ms)}ms early`;
  if (ms < 60_000) return `${ms}ms`;
  const min = Math.floor(ms / 60_000);
  return `${min}m`;
}

function TabChip({ tab }: { tab: string }) {
  const lower = tab.toLowerCase();
  const className =
    lower === 'primary'
      ? 'bg-emerald-100 text-emerald-700'
      : lower === 'promotions'
      ? 'bg-amber-100 text-amber-700'
      : lower === 'spam' || lower === 'junk'
      ? 'bg-rose-100 text-rose-700'
      : 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{tab}</span>
  );
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-0.5 text-sm text-slate-700 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}