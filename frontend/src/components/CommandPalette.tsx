'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFeatures } from '@/features/FeatureProvider';
import { FEATURES, GROUP_LABELS } from '@/features/registry';
import { Kbd } from './kit/ui';

const EXTRA = [
  { label: 'Overview', href: '/', section: 'Go to' },
  { label: 'Connect inbox', href: '/inboxes/connect', section: 'Go to' },
  { label: 'Plan & credits', href: '/billing', section: 'Go to' },
  { label: 'Account and data', href: '/account', section: 'Go to' },
  { label: 'Feature review', href: '/features', section: 'Go to' },
];

/** Cmd/Ctrl+K jump-to. Searches every page that is currently switched on. */
export function CommandPalette() {
  const router = useRouter();
  const { isEnabled } = useFeatures();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setIndex(0);
      } else if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const items = [
      ...EXTRA,
      ...FEATURES.filter((f) => f.group !== 'shell' && isEnabled(f.id)).map((f) => ({
        label: f.label,
        href: f.href,
        section: GROUP_LABELS[f.group],
      })),
    ];
    const q = query.trim().toLowerCase();
    return (q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.section.toLowerCase().includes(q)) : items).slice(0, 12);
  }, [query, isEnabled]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setQuery('');
          setIndex(0);
        }}
        className="hidden h-8 items-center gap-2 rounded-lg border border-stone-200 bg-white px-2.5 text-[13px] text-stone-500 hover:bg-stone-50 sm:flex"
        aria-label="Search and jump to a page"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        Search
        <Kbd>⌘K</Kbd>
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
          <button type="button" aria-label="Close search" className="absolute inset-0 bg-stone-900/40" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl">
            <input
              ref={input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIndex((i) => Math.min(results.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIndex((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter' && results[index]) go(results[index].href);
              }}
              placeholder="Jump to a page…"
              aria-label="Search pages"
              className="w-full border-b border-stone-100 px-4 py-3 text-sm outline-none placeholder:text-stone-400"
            />
            <ul className="max-h-80 overflow-y-auto p-1.5" role="listbox">
              {results.length === 0 ? <li className="px-3 py-6 text-center text-sm text-stone-500">Nothing matches.</li> : null}
              {results.map((r, i) => (
                <li key={`${r.section}-${r.href}`} role="option" aria-selected={i === index}>
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => go(r.href)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] ${i === index ? 'bg-brand-50 text-brand-900' : 'text-stone-700'}`}
                  >
                    {r.label}
                    <span className="eyebrow">{r.section}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
