'use client';

import Link from 'next/link';
import { useSession } from '@/lib/auth';
import { AppNav } from './AppNav';
import { LiveStatusCard } from './LiveStatusCard';
import { BrandMark, BrandWordmark } from './brand/BrandMark';

/** Sidebar content, shared by the desktop rail and the mobile drawer. */
export function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useSession();
  const user = data?.user;
  return (
    <div className="flex h-full flex-col">
      <Link
        href="/"
        onClick={onNavigate}
        className="flex h-14 shrink-0 items-center gap-2.5 px-4"
        aria-label="EmailWarm overview"
      >
        <BrandMark className="h-8 w-8" />
        <BrandWordmark className="text-[15px]" />
      </Link>

      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        <LiveStatusCard />
        <AppNav onNavigate={onNavigate} />
      </div>

      {user ? (
        <Link
          href="/account"
          onClick={onNavigate}
          className="flex shrink-0 items-center gap-2.5 border-t border-stone-200 px-4 py-3 transition-colors hover:bg-stone-50"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800"
            aria-hidden
          >
            {(user.name ?? user.email ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-stone-800">
              {user.name || user.email}
            </span>
            {user.name ? (
              <span className="block truncate text-xs text-stone-500">{user.email}</span>
            ) : null}
          </span>
        </Link>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-stone-200 bg-stone-50/60 md:block">
      <div className="sticky top-0 h-screen">
        <SidebarBody />
      </div>
    </aside>
  );
}
