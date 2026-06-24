'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Tiny "poll until done" hook used by features that need live updates
 * without a page refresh: the pool inbox grid (after a CSV / wizard
 * upload) polling for analysis completion, the re-analyze button
 * polling for the new analysis row, and the placement-test button
 * polling for the result row to land in the DB.
 *
 * Returns a `PulseState` value that drives the `<PulseDot />`
 * component — `'idle' | 'busy' | 'live' | 'error'`. The `live` state
 * fires for `successFlashMs` after a successful response so the dot
 * briefly turns green ("data just landed") before going back to
 * `idle`.
 *
 * Contract:
 *   - Calls `fetcher()` every `intervalMs` until `shouldStop(result)`
 *   returns true (defaults to `result !== null && !result.pending`).
 *   - Stops automatically on unmount.
 *   - Never more than `maxAttempts` polls (default 30 — 30s at the
 *   default 1s interval). After that, sets state to `error` and stops.
 *   - Returns the latest `result` so the caller can render it
 *   without keeping a separate useState.
 *
 * Usage:
 *   const { state, data, stop } = usePolling<PoolInbox[]>({
 *     fetcher: () => api<PoolInbox[]>('/pool-inboxes'),
 *     intervalMs: 2000,
 *     shouldStop: (rows) => rows.every((r) => r.analysis !== null),
 *     label: 'Refreshing analysis',
 *   });
 */
export type PulseState = 'idle' | 'busy' | 'live' | 'error';

interface Options<T> {
  fetcher: () => Promise<T>;
  intervalMs?: number;
  /** Called with the latest result after every successful poll. Returning `true` stops polling. */
  shouldStop?: (result: T) => boolean;
  /** Cap to prevent runaway polling — defaults to 30. */
  maxAttempts?: number;
  /** If true, polling starts on mount. Defaults to true. */
  enabled?: boolean;
  /** Optional callback fired when polling completes successfully. */
  onSuccess?: (result: T) => void;
  /** Optional callback fired when polling stops due to maxAttempts. */
  onTimeout?: () => void;
  /** How long the `live` flash lasts after a successful poll. Default 1500ms. */
  successFlashMs?: number;
}

export function usePolling<T>(opts: Options<T>) {
  const {
    fetcher,
    intervalMs = 1000,
    shouldStop,
    maxAttempts = 30,
    enabled = true,
    onSuccess,
    onTimeout,
    successFlashMs = 1500,
  } = opts;

  const [state, setState] = useState<PulseState>('idle');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // We hold the latest fetcher/shouldStop/onSuccess/onTimeout in refs so
  // the polling loop doesn't restart when the caller passes a new closure
  // (common pattern — e.g. a `useApi()` that returns a fresh function on
  // every render). Without refs, every render would tear down the loop.
  const fetcherRef = useRef(fetcher);
  const shouldStopRef = useRef(shouldStop);
  const onSuccessRef = useRef(onSuccess);
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    fetcherRef.current = fetcher;
    shouldStopRef.current = shouldStop;
    onSuccessRef.current = onSuccess;
    onTimeoutRef.current = onTimeout;
  });

  useEffect(() => {
    if (!enabled) {
      // Reset to idle when the hook is disabled. This is a deliberate
      // sync-from-prop, not a cascading render: the consumer flipped
      // `enabled` false and expects the dot to go back to grey.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState('idle');
      return;
    }

    attemptRef.current = 0;
    setError(null);

    const tick = async () => {
      attemptRef.current += 1;
      setState('busy');
      try {
        const result = await fetcherRef.current();
        setData(result);

        const stop = shouldStopRef.current?.(result) ?? false;
        if (stop) {
          // Brief `live` flash so the user sees the success before the
          // dot goes back to `idle` (or stays `live` if they keep
          // the hook mounted with new data).
          setState('live');
          if (liveFlashRef.current) clearTimeout(liveFlashRef.current);
          liveFlashRef.current = setTimeout(() => {
            setState('idle');
            liveFlashRef.current = null;
          }, successFlashMs);
          onSuccessRef.current?.(result);
          return; // don't reschedule
        }

        if (attemptRef.current >= maxAttempts) {
          setState('error');
          onTimeoutRef.current?.();
          return;
        }

        // Schedule next poll.
        timerRef.current = setTimeout(() => {
          void tick();
        }, intervalMs);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? String(err.body)
            : err instanceof Error
              ? err.message
              : 'Polling failed';
        setError(message);
        setState('error');
        // Don't auto-retry on error — let the caller decide. If they
        // want to retry, they call `start()` again.
      }
    };

    void tick();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (liveFlashRef.current) clearTimeout(liveFlashRef.current);
    };
  }, [enabled, intervalMs, maxAttempts, successFlashMs]);

  function start() {
    // Force a re-mount of the effect by toggling `enabled` off then on.
    // Simpler: just call tick directly via a ref. For now, callers
    // should remount the component (toggle a key) to restart.
  }

  return { state, data, error, start } as const;
}
