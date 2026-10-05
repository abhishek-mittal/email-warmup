'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFeatures } from '@/features/FeatureProvider';
import { NOTIFICATIONS, TEAMMATES, WORKSPACES } from '@/mock/chrome';
import { Avatar } from './kit/ui';
import { useNotify } from './kit/Notify';
import { CommandPalette } from './CommandPalette';

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function WorkspaceSwitcher() {
  const { open, setOpen, ref } = usePopover();
  const { preview } = useNotify();
  const [current, setCurrent] = useState(WORKSPACES[0]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 items-center gap-2 rounded-lg px-1.5 text-[13px] font-medium text-stone-800 hover:bg-stone-100"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-[10px] font-semibold text-white">{current.initials}</span>
        <span className="hidden max-w-[10rem] truncate sm:block">{current.name}</span>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-stone-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div role="menu" className="absolute left-0 top-10 z-30 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white p-1 shadow-lg">
          <p className="eyebrow px-3 py-2">Workspaces</p>
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setCurrent(w);
                setOpen(false);
                preview('Switching workspace');
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-stone-100"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-600">{w.initials}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-stone-900">{w.name}</span>
                <span className="block text-xs text-stone-500">{w.plan} · {w.members} {w.members === 1 ? 'member' : 'members'}</span>
              </span>
              {w.id === current.id ? <span className="text-brand-600">✓</span> : null}
            </button>
          ))}
          <div className="mt-1 border-t border-stone-100 p-1">
            <Link href="/select-org" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-[13px] text-stone-700 hover:bg-stone-100">
              All workspaces
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Presence() {
  return (
    <div className="hidden -space-x-1.5 sm:flex" aria-label={`${TEAMMATES.length} teammates online`} role="group">
      {TEAMMATES.map((t) => (
        <span key={t} title={`${t} is online`} className="rounded-full ring-2 ring-white">
          <Avatar name={t} size="sm" />
        </span>
      ))}
    </div>
  );
}

function Bell() {
  const { open, setOpen, ref } = usePopover();
  const { preview } = useNotify();
  const unread = NOTIFICATIONS.filter((n) => n.unread).length;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100"
      >
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand-600 ring-2 ring-white" /> : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-10 z-30 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-stone-100 px-3.5 py-2.5">
            <p className="text-[13px] font-medium text-stone-900">Notifications</p>
            <button type="button" onClick={() => preview('Marking as read')} className="text-xs text-brand-700 hover:underline">
              Mark all read
            </button>
          </div>
          <ul className="max-h-80 divide-y divide-stone-100 overflow-y-auto">
            {NOTIFICATIONS.map((n) => (
              <li key={n.id} className="flex gap-2.5 px-3.5 py-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.unread ? 'bg-brand-600' : 'bg-transparent'}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-stone-900">{n.title}</p>
                  <p className="truncate text-xs text-stone-500">{n.body}</p>
                </div>
                <span className="shrink-0 text-xs text-stone-400">{n.time}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Optional pieces of the top bar, each behind its own keep/hide switch. */
export function TopbarLeading() {
  const { isEnabled } = useFeatures();
  return isEnabled('workspaces') ? <WorkspaceSwitcher /> : null;
}

export function TopbarTrailing() {
  const { isEnabled } = useFeatures();
  return (
    <div className="flex items-center gap-2">
      {isEnabled('presence') ? <Presence /> : null}
      {isEnabled('notif_bell') ? <Bell /> : null}
      {isEnabled('cmd_palette') ? <CommandPalette /> : null}
    </div>
  );
}
