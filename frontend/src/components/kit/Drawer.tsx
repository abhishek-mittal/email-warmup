'use client';

import { useEffect, useRef } from 'react';

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

/** Right-hand detail drawer: closes on Escape and on a click outside. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-md' }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode; width?: string }) {
  useEscape(open, onClose);
  const panel = useRef<HTMLDivElement>(null);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <div ref={panel} className={`absolute inset-y-0 right-0 flex w-full ${width} flex-col bg-white shadow-xl`}>
        <header className="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-stone-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 truncate text-xs text-stone-500">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close panel" className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <footer className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Centered dialog for create/edit forms. */
export function Modal({ open, onClose, title, description, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode; width?: string }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-stone-900/40" onClick={onClose} />
      <div className={`relative flex max-h-[90vh] w-full ${width} flex-col overflow-hidden rounded-xl bg-white shadow-xl`}>
        <header className="border-b border-stone-100 px-5 py-4">
          <h2 className="text-base font-semibold text-stone-900">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-stone-500">{description}</p> : null}
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <footer className="flex items-center justify-end gap-2 border-t border-stone-100 bg-stone-50 px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}
