'use client';

import { useState } from 'react';
import Link from 'next/link';
import { signIn } from '@/lib/auth';
import { useRouter } from 'next/navigation';

export default function Page() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn.email({ email, password, callbackURL: '/inboxes' });
      router.push('/inboxes');
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function onOAuth(provider: 'google' | 'microsoft') {
    setBusy(true);
    setError(null);
    try {
      await signIn.social({ provider, callbackURL: '/inboxes' });
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? `${provider} sign-in failed`);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl">
        <h1 className="mb-1 text-2xl font-semibold text-slate-900">Welcome back</h1>
        <p className="mb-6 text-sm text-slate-600">Sign in to EmailWarm to manage your warmed inboxes.</p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onOAuth('google')}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Google
          </button>
          <button
            type="button"
            onClick={() => onOAuth('microsoft')}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Microsoft
          </button>
        </div>

        <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          or with email
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        </form>

        <p className="mt-6 text-center text-sm text-slate-600">
          New here?{' '}
          <Link href="/sign-up" className="font-medium text-indigo-600 hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}