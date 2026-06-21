'use client';

import { useSession, signOut } from '@/lib/auth';
import { useRouter } from 'next/navigation';

export function Topbar() {
  const { data, isPending } = useSession();
  const router = useRouter();
  const user = data?.user;

  async function onSignOut() {
    await signOut();
    router.push('/sign-in');
  }

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="text-sm text-slate-500">
        {isPending ? 'Loading…' : user ? `Signed in as ${user.email}` : null}
      </div>
      {user ? (
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
            {(user.name ?? user.email ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </header>
  );
}