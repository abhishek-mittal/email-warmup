'use client';

import { useState } from 'react';
import { AuthShell } from '@/components/brand/AuthShell';
import Link from 'next/link';
import { signUp } from '@/lib/auth';
import { useRouter } from 'next/navigation';

export default function Page() {
  const [name, setName] = useState('');
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
      await signUp.email({ email, password, name, callbackURL: '/inboxes' });
      router.push('/inboxes');
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? 'Sign-up failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
        <h1 className="mb-1 text-2xl font-semibold text-stone-900">Create account</h1>
        <p className="mb-6 text-sm text-stone-600">
          Start warming your inboxes in minutes.
        </p>

        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Creating account…' : 'Create account'}
          </button>
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        </form>

        <p className="mt-6 text-center text-sm text-stone-600">
          Already have one?{' '}
          <Link href="/sign-in" className="font-medium text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      </AuthShell>
  );
}
