'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import { PulseDot } from '@/components/PulseDot';
import { formatDateTime } from '@/lib/format';
import type {
  PoolActivityEvent,
  PoolActivityEventType,
  PoolActivityPage,
  PoolActivityStats,
} from '@/lib/pool-activity-types';

interface Props {
  poolInboxId: string;
}

const PAGE_SIZE = 50;

const EVENT_CONFIG: Record<
  PoolActivityEventType,
  { dotClass: string; label: string }
> = {
  received: { dotClass: 'bg-sky-500', label: 'Received' },
  opened: { dotClass: 'bg-emerald-500', label: 'Opened' },
  starred: { dotClass: 'bg-amber-500', label: 'Starred' },
  replied: { dotClass: 'bg-emerald-500', label: 'Replied' },
  rescued: { dotClass: 'bg-violet-500', label: 'Rescued from spam' },
  spam_landed: { dotClass: 'bg-rose-500', label: 'Landed in spam' },
  filed: { dotClass: 'bg-stone-400', label: 'Filed' },
};

function renderEvent(event: PoolActivityEvent): string {
  const p = event.payload as Record<string, unknown>;
  const sender = (p.senderEmail as string) ?? 'unknown sender';
  const subject = p.subject ? ` · "${truncate(p.subject as string, 60)}"` : '';
  switch (event.type) {
    case 'received':
      return `Received warmup email from ${sender}${subject}`;
    case 'opened':
      return `Opened email from ${sender}`;
    case 'starred':
      return `Starred email from ${sender}`;
    case 'replied':
      return `Replied to ${sender}`;
    case 'rescued':
      return `Rescued email from spam (sent by ${sender})`;
    case 'spam_landed':
      return `Email from ${sender} landed in spam`;
    case 'filed':
      return `Filed email from ${sender} to WarmupHub`;
    default:
      return EVENT_CONFIG[event.type as PoolActivityEventType]?.label ?? 'Unknown event';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

export function PoolActivityTab({ poolInboxId }: Props) {
  const api = useApi();
  const [events, setEvents] = useState<PoolActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [stats, setStats] = useState<PoolActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialLoadDone = useRef(false);

  const load = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (after) params.set('cursor', after);
      return api<PoolActivityPage>(
        `/pool-inboxes/${poolInboxId}/activity?${params.toString()}`,
      );
    },
    [api, poolInboxId],
  );

  // Initial load — fetch activity + stats in parallel.
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    setLoading(true);
    setError(null);
    Promise.all([
      load(null),
      api<PoolActivityStats>(`/pool-inboxes/${poolInboxId}/activity-stats`),
    ])
      .then(([activityPage, statsRes]) => {
        setEvents(activityPage.events);
        setCursor(activityPage.nextCursor);
        setHasMore(Boolean(activityPage.nextCursor));
        setStats(statsRes);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      })
      .finally(() => setLoading(false));
  }, [load, api, poolInboxId]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const data = await load(cursor);
      setEvents((prev) => [...prev, ...data.events]);
      setCursor(data.nextCursor);
      setHasMore(Boolean(data.nextCursor));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load more events');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="space-y-4">
      {/* Stats bar */}
      {stats ? (
        <div className="flex flex-wrap gap-2">
          <StatChip label="Received" value={stats.received} />
          <StatChip
            label="Opened"
            value={stats.opened}
            percent={stats.openRate}
          />
          <StatChip
            label="Replied"
            value={stats.replied}
            percent={stats.replyRate}
          />
          <StatChip label="Rescued" value={stats.rescued} />
          <StatChip
            label="Spam"
            value={stats.spamCount}
            percent={stats.spamRate}
            tone={stats.spamRate !== null && stats.spamRate > 10 ? 'warning' : undefined}
          />
        </div>
      ) : null}

      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-stone-700">Activity timeline</h2>
        <p className="mt-1 text-xs text-stone-500">
          Most recent first. Pool inboxes receive warmup emails from the inboxes you&rsquo;re
          warming and take actions (open, star, reply, rescue).
        </p>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-stone-500">
            <PulseDot state="busy" label="Loading activity" />
            Loading activity…
          </div>
        ) : events.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
            No warmup emails received yet. This pool inbox will start appearing here once it
            is paired with an inbox being warmed.
          </div>
        ) : (
          <ul className="mt-6 space-y-3">
            {events.map((event, idx) => {
              const cfg = EVENT_CONFIG[event.type];
              return (
                <li
                  key={`${event.timestamp}-${idx}`}
                  className="flex items-start gap-3"
                >
                  <div className="mt-1.5 flex h-2.5 w-2.5 flex-none items-center justify-center">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${cfg?.dotClass ?? 'bg-stone-300'}`}
                      title={cfg?.label ?? event.type}
                      aria-hidden
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-stone-800">{renderEvent(event)}</p>
                    <p
                      className="text-xs text-stone-500"
                      title={new Date(event.timestamp).toISOString()}
                    >
                      {formatRelative(event.timestamp)} · {formatDateTime(event.timestamp)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {hasMore ? (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="rounded-full border border-stone-300 bg-white px-4 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StatChip({
  label,
  value,
  percent,
  tone,
}: {
  label: string;
  value: number;
  percent?: number | null;
  tone?: 'warning';
}) {
  const toneClass = tone === 'warning'
    ? 'border-amber-300 bg-amber-50 text-amber-800'
    : 'border-stone-200 bg-stone-50 text-stone-700';
  return (
    <div className={`rounded-full border px-3 py-1.5 text-xs ${toneClass}`}>
      <span className="font-medium">{label}: {value}</span>
      {percent !== undefined && percent !== null ? (
        <span className="ml-1 text-stone-500">({percent}%)</span>
      ) : null}
    </div>
  );
}