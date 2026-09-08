'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import { PulseDot } from '@/components/PulseDot';
import { formatDateTime } from '@/lib/format';
import type { ActivityEvent, ActivityEventType, ActivityPage } from '@/lib/activity-types';

interface Props {
  inboxId: string;
}

const PAGE_SIZE = 50;

const EVENT_CONFIG: Record<
  ActivityEventType,
  {
    /** Tailwind classes for the icon dot (background + small inner mark). */
    dotClass: string;
    /** A short user-facing label for the event category, used as a tooltip. */
    label: string;
  }
> = {
  sent: { dotClass: 'bg-sky-500', label: 'Sent' },
  opened: { dotClass: 'bg-emerald-500', label: 'Opened' },
  replied: { dotClass: 'bg-emerald-500', label: 'Replied' },
  starred: { dotClass: 'bg-amber-500', label: 'Starred' },
  rescued: { dotClass: 'bg-violet-500', label: 'Rescued from spam' },
  spam_landed: { dotClass: 'bg-rose-500', label: 'Landed in spam' },
  filed: { dotClass: 'bg-slate-400', label: 'Filed' },
  dns_check: { dotClass: 'bg-sky-500', label: 'DNS check' },
  blacklist_check: { dotClass: 'bg-sky-500', label: 'Blacklist check' },
  score_updated: { dotClass: 'bg-teal-500', label: 'Score updated' },
};

/**
 * Render an activity event into a single sentence for the timeline
 * row. Receivers / subjects / scores are pulled out of `payload` —
 * the backend pre-shapes them so the frontend doesn't need to know
 * the underlying tables.
 */
function renderEvent(event: ActivityEvent): string {
  const p = event.payload as Record<string, unknown>;
  const receiver = (p.receiverEmail as string) ?? 'unknown recipient';
  switch (event.type) {
    case 'sent': {
      const subject = p.subject ? ` · Subject: "${truncate(p.subject as string, 60)}"` : '';
      return `Sent warmup email to ${receiver}${subject}`;
    }
    case 'opened':
      return `Warmup email opened by ${receiver}`;
    case 'replied':
      return `Reply received from ${receiver}`;
    case 'starred':
      return `Email starred by ${receiver}`;
    case 'rescued': {
      const tab = (p.landedInTab as string) ?? 'Spam';
      return `Email rescued from ${tab} by ${receiver}`;
    }
    case 'spam_landed': {
      const tab = (p.landedInTab as string) ?? 'Spam';
      return `Email landed in ${tab} at ${receiver}`;
    }
    case 'filed':
      return `Email filed to WarmupHub folder (from ${receiver})`;
    case 'dns_check':
      return `DNS check completed${typeof p.score === 'number' ? ` · Score: ${p.score}` : ''}`;
    case 'blacklist_check': {
      const clean = p.isClean;
      if (clean) return 'Blacklist check: clean';
      const count = typeof p.listedCount === 'number' ? p.listedCount : '?';
      return `Blacklist check: listed on ${count} RBL${count === 1 ? '' : 's'}`;
    }
    case 'score_updated':
      return `Reputation score updated: ${p.prev} → ${p.current} (${p.trend})`;
    default:
      return EVENT_CONFIG[event.type as ActivityEventType]?.label ?? 'Unknown event';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Chronological timeline of warmup events for one inbox. Loads the
 * first page on mount, then 50 more per "Load more" click. Cursor
 * pagination keeps response size bounded — the backend caps at
 * 50×4 expanded events per page (the over-fetch handles the
 * warmup_sends fan-out).
 */
export function ActivityFeedTab({ inboxId }: Props) {
  const api = useApi();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialLoadDone = useRef(false);

  const load = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (after) params.set('cursor', after);
      const path = `/inboxes/${inboxId}/activity?${params.toString()}`;
      const data = await api<ActivityPage>(path);
      return data;
    },
    [api, inboxId],
  );

  // Initial load
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    setLoading(true);
    setError(null);
    load(null)
      .then((data) => {
        setEvents(data.events);
        setCursor(data.nextCursor);
        setHasMore(Boolean(data.nextCursor));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      })
      .finally(() => setLoading(false));
  }, [load]);

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
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">Activity Feed</h2>
      <p className="mt-1 text-xs text-slate-500">
        Most recent first. Sent, opened, replied, rescued, and other warmup events.
      </p>

      {error ? (
        <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <PulseDot state="busy" label="Loading activity" />
          Loading activity…
        </div>
      ) : events.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          No warmup activity yet. Warmup emails will appear here once the engine starts sending for this inbox.
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {events.map((event, idx) => {
            const cfg = EVENT_CONFIG[event.type];
            return (
              <li key={`${event.timestamp}-${idx}`} className="flex items-start gap-3">
                <div className="mt-1.5 flex h-2.5 w-2.5 flex-none items-center justify-center">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${cfg?.dotClass ?? 'bg-slate-300'}`}
                    title={cfg?.label ?? event.type}
                    aria-hidden
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-800">{renderEvent(event)}</p>
                  <p
                    className="text-xs text-slate-500"
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
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? (
              <>
                <PulseDot state="busy" size="xs" label="Loading more" />
                Loading…
              </>
            ) : (
              'Load more'
            )}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Compact relative-time formatter for the timeline ("2 hours ago",
 * "yesterday", etc.). Matches the language the rest of the dashboard
 * uses — see the design reference in T027 §4 Tab 1.
 */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  const wk = Math.floor(day / 7);
  if (wk < 4) return `${wk} week${wk === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} year${yr === 1 ? '' : 's'} ago`;
}