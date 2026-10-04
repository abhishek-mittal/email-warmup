'use client';

import { useState } from 'react';
import { useApi } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { PulseDot } from '@/components/PulseDot';
import type { PoolLiveStatus, PoolLiveJob } from '@/lib/pool-activity-types';

interface Props {
  poolInboxId: string;
}

const ACTION_LABEL: Record<string, string> = {
  open: 'open',
  star: 'star',
  reply: 'reply',
  rescue: 'rescue from spam',
};

function describeActions(actions: string[]): string {
  if (actions.length === 0) return 'process';
  return actions.map((a) => ACTION_LABEL[a] ?? a).join(' + ');
}

function formatRelativeFuture(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'any moment now';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'in under a minute';
  if (mins === 1) return 'in 1 min';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
}

/**
 * Polls `GET /pool-inboxes/:id/live-status` every 3s and shows real
 * BullMQ job state for this pool inbox's warmup-receive queue — what's
 * processing right now, and what's queued/delayed next. Sourced from
 * the actual queue, not a simulation: jobs run on a 2-240 minute
 * jittered delay after each warmup send (see warmup-send.processor.ts),
 * so an empty panel most of the time is expected, not broken — the copy
 * below says so explicitly.
 *
 * `usePolling` deliberately stops retrying after a fetch error (see
 * use-polling.ts:133-144) — for most callers that's correct (poll until
 * done, let the caller decide whether to restart). But this panel is a
 * continuous live indicator meant to be left open for a long session, so
 * a single transient error (a momentary 502, network blip, etc.) must
 * not permanently freeze it. `usePolling`'s own `start()` is a no-op
 * stub whose comment says callers should "remount the component (toggle
 * a key) to restart" — so `LiveStatusPanel` is a thin wrapper that owns
 * a `pollKey` and remounts `LiveStatusPollerInner` (which is the only
 * thing that calls `usePolling`) on every Retry click. Remounting tears
 * down and re-runs `usePolling`'s internal `useEffect` (use-polling.ts:88)
 * from scratch, which calls `tick()` again and actually resumes polling —
 * not just clearing the error message in the UI.
 */
export function LiveStatusPanel({ poolInboxId }: Props) {
  const [pollKey, setPollKey] = useState(0);

  return (
    <LiveStatusPollerInner
      key={pollKey}
      poolInboxId={poolInboxId}
      onRetry={() => setPollKey((k) => k + 1)}
    />
  );
}

interface InnerProps extends Props {
  onRetry: () => void;
}

function LiveStatusPollerInner({ poolInboxId, onRetry }: InnerProps) {
  const api = useApi();

  const { data, error } = usePolling<PoolLiveStatus>({
    fetcher: () => api<PoolLiveStatus>(`/pool-inboxes/${poolInboxId}/live-status`),
    intervalMs: 3000,
    // Never "stop" — this is a continuous live indicator, not a
    // poll-until-done task. shouldStop always false plus a very high
    // maxAttempts keeps it polling indefinitely while the page is open.
    shouldStop: () => false,
    maxAttempts: Number.MAX_SAFE_INTEGER,
  });

  const active = data?.active ?? [];
  const upcoming = data?.upcoming ?? [];
  // Derived from data, not usePolling's internal `state`: with
  // shouldStop always false, `state` sits at 'busy' permanently after
  // the first tick (including the 3s gaps between polls), so it can't
  // tell us "a fetch is in flight" — only `error` (last attempt's
  // outcome) and the active-jobs list are meaningful signals here.
  const pulseState = error ? 'error' : active.length > 0 ? 'live' : 'idle';

  return (
    <section
      className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
      data-testid="live-status-panel"
    >
      <div className="flex items-center gap-2">
        <PulseDot state={pulseState} label="Live warmup-receive status" />
        <h2 className="text-sm font-semibold text-stone-900">Live status</h2>
      </div>

      {error ? (
        <div className="mt-2 flex items-center gap-2">
          <p className="text-xs text-rose-600">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-rose-300 px-2 py-0.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50"
          >
            Retry
          </button>
        </div>
      ) : active.length === 0 && upcoming.length === 0 ? (
        <p className="mt-2 text-xs text-stone-500">
          No warmup activity scheduled right now — jobs run on a jittered 2&ndash;240 minute
          delay after each send, so this is normal between sends.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {active.map((job: PoolLiveJob) => (
            <p key={job.jobId} className="text-sm text-stone-800">
              <span className="font-medium text-emerald-700">Processing now</span> &mdash;{' '}
              {describeActions(job.actions)} email from{' '}
              <span className="font-mono text-xs">{job.senderEmail ?? 'unknown sender'}</span>
            </p>
          ))}
          {upcoming.map((job: PoolLiveJob) => (
            <p key={job.jobId} className="text-sm text-stone-600">
              Will {describeActions(job.actions)} email from{' '}
              <span className="font-mono text-xs">{job.senderEmail ?? 'unknown sender'}</span>{' '}
              {formatRelativeFuture(job.executeAt)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
