'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession, signOut } from '@/lib/auth';
import { MobileNav } from './MobileNav';
import { TopbarLeading, TopbarTrailing } from './TopbarChrome';
import { FEATURES } from '@/features/registry';

const LABELS: Record<string, string> = {
  inboxes: 'Accounts',
  connect: 'Connect inbox',
  pool: 'Warming pool',
  billing: 'Plan & credits',
  account: 'Account',
  diagnostics: 'Diagnostics',
  settings: 'Settings',
  'api-keys': 'API keys',
  audit: 'Audit log',
  features: 'Feature review',
  batches: 'Batches',
  // Everything else comes from the feature registry's last path segment.
  ...Object.fromEntries(FEATURES.map((f) => [f.href.split('/').filter(Boolean).pop() ?? '', f.label])),
};

const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-|^\d+$|^[a-z]{1,3}\d+$/i;

interface Crumb {
  label: string;
  href: string;
}

/** Breadcrumb trail from the URL; ids become "Details". */
function crumbsFor(pathname: string): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ label: 'Overview', href: '/' }];
  parts.forEach((part, i) => {
    crumbs.push({
      label: ID_LIKE.test(part) ? 'Details' : (LABELS[part] ?? part),
      href: `/${parts.slice(0, i + 1).join('/')}`,
    });
  });
  return crumbs;
}

function UserMenu() {
  const { data } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const user = data?.user;

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  async function onSignOut() {
    setOpen(false);
    await signOut();
    router.push('/sign-in');
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800 ring-offset-2 transition hover:ring-2 hover:ring-brand-200"
      >
        {(user.name ?? user.email ?? '?').slice(0, 1).toUpperCase()}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-10 z-30 w-60 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
        >
          <div className="border-b border-stone-100 px-3 py-2.5">
            <p className="truncate text-[13px] font-medium text-stone-900">{user.name || 'Signed in'}</p>
            <p className="truncate text-xs text-stone-500">{user.email}</p>
          </div>
          <div className="p-1">
            <Link
              role="menuitem"
              href="/account"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-[13px] text-stone-700 hover:bg-stone-100"
            >
              Account and data
            </Link>
            <Link
              role="menuitem"
              href="/billing"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-[13px] text-stone-700 hover:bg-stone-100"
            >
              Plan and credits
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={onSignOut}
              className="block w-full rounded-lg px-3 py-2 text-left text-[13px] text-stone-700 hover:bg-stone-100"
            >
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Topbar() {
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname);
  // On phones only the current page and its parent are shown.
  const visible = crumbs.slice(-2);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-stone-200 bg-white/90 px-4 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileNav />
        <TopbarLeading />
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-1.5 text-[13px]">
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              const hiddenOnPhone = !visible.includes(crumb);
              return (
                <li
                  key={crumb.href}
                  className={`min-w-0 items-center gap-1.5 ${hiddenOnPhone ? 'hidden sm:flex' : 'flex'}`}
                >
                  {i > 0 ? <span className="text-stone-300" aria-hidden>/</span> : null}
                  {last ? (
                    <span aria-current="page" className="truncate font-medium text-stone-900">
                      {crumb.label}
                    </span>
                  ) : (
                    <Link href={crumb.href} className="truncate text-stone-500 hover:text-stone-800">
                      {crumb.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <TopbarTrailing />
        <UserMenu />
      </div>
    </header>
  );
}
