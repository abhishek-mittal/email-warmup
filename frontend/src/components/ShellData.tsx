'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/api';

export interface ShellSummary {
  /** loading: first fetch pending. error: the service could not be reached. */
  state: 'loading' | 'ready' | 'error';
  total: number;
  active: number;
  /** Paused by the owner or the system. */
  paused: number;
  /** Pending, errored or disconnected: needs the owner to act. */
  attention: number;
}

const EMPTY: ShellSummary = { state: 'loading', total: 0, active: 0, paused: 0, attention: 0 };
const POLL_MS = 30_000;

const ShellDataContext = createContext<ShellSummary>(EMPTY);

export const useShellSummary = () => useContext(ShellDataContext);

/**
 * One poll of the inbox list shared by everything in the app shell (sidebar
 * status card, nav badge). Pauses while the tab is hidden. A failed request
 * is reported as `error`, never as zero inboxes.
 */
export function ShellDataProvider({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const [summary, setSummary] = useState<ShellSummary>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const rows = await api<Array<{ status: string }>>('/inboxes');
        if (cancelled) return;
        const count = (...statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;
        setSummary({
          state: 'ready',
          total: rows.length,
          active: count('active'),
          paused: count('paused'),
          attention: count('pending', 'error', 'disconnected'),
        });
      } catch {
        if (!cancelled) setSummary((prev) => ({ ...prev, state: 'error' }));
      }
      if (!cancelled && !document.hidden) timer = setTimeout(load, POLL_MS);
    }

    function onVisibility() {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
      } else {
        void load();
      }
    }

    void load();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api]);

  const value = useMemo(() => summary, [summary]);
  return <ShellDataContext.Provider value={value}>{children}</ShellDataContext.Provider>;
}
