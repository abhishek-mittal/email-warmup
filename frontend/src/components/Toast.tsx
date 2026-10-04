'use client';

import { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  kind?: 'success' | 'error' | 'info';
  onDone?: () => void;
}

export function Toast({ message, kind = 'info', onDone }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), 4000);
    return () => clearTimeout(t);
  }, [onDone]);

  const colors =
    kind === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : kind === 'error'
      ? 'border-rose-200 bg-rose-50 text-rose-800'
      : 'border-stone-200 bg-stone-50 text-stone-800';

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-lg ${colors}`}
      role="status"
    >
      <span className="h-2 w-2 rounded-full bg-current" aria-hidden />
      {message}
    </div>
  );
}

interface ToastState {
  message: string;
  kind: 'success' | 'error' | 'info';
}

export function useToasts() {
  const [toast, setToast] = useState<ToastState | null>(null);
  return {
    toast,
    show: (message: string, kind: 'success' | 'error' | 'info' = 'info') =>
      setToast({ message, kind }),
    clear: () => setToast(null),
  };
}
