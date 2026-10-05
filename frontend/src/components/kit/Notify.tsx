'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

interface NotifyApi {
  notify: (message: string, tone?: Toast['tone']) => void;
  /** For controls that have no backend yet. */
  preview: (what?: string) => void;
}

const NotifyContext = createContext<NotifyApi | null>(null);

export function useNotify(): NotifyApi {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error('useNotify must be used inside NotifyProvider');
  return ctx;
}

const TONE: Record<Toast['tone'], string> = {
  info: 'border-stone-200 bg-white text-stone-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-rose-200 bg-rose-50 text-rose-900',
};

/** App-wide toasts. Stub controls call `preview()` so nothing pretends to have saved. */
export function NotifyProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++next.current;
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const api = useMemo<NotifyApi>(
    () => ({
      notify,
      preview: (what) => notify(`${what ?? 'This'} is a preview. It isn’t connected yet, so nothing was saved.`),
    }),
    [notify],
  );

  return (
    <NotifyContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto rounded-lg border px-3.5 py-2.5 text-sm shadow-lg ${TONE[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
}
