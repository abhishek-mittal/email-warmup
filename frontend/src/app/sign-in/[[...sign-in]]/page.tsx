'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { AuthShell } from '@/components/brand/AuthShell';
import Link from 'next/link';
import { signIn } from '@/lib/auth';
import { useRouter, useSearchParams } from 'next/navigation';

/** Shown after a successful password reset sends the person back here. */
function ResetNotice() {
  if (!useSearchParams().get('reset')) return null;
  return (
    <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      Your password was changed. Sign in with the new one.
    </p>
  );
}

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

  const onCitadel = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const redirect =
        new URLSearchParams(window.location.search).get('redirect_url') || '/inboxes';
      const res = await signIn.oauth2({ providerId: 'citadel', callbackURL: redirect });
      // better-auth's client redirect plugin does not reliably navigate here, so
      // drive the redirect to Citadel ourselves from the returned authorize URL.
      const url = (res as { data?: { url?: string }; url?: string } | undefined)?.data?.url
        ?? (res as { url?: string } | undefined)?.url;
      if (url) {
        window.location.href = url;
        return;
      }
      const errMsg = (res as { error?: { message?: string } } | undefined)?.error?.message;
      setError(errMsg ?? 'WebNCO ID sign-in failed');
      setBusy(false);
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? 'WebNCO ID sign-in failed');
      setBusy(false);
    }
  }, []);

  // Bounced here from a protected route -> start Citadel SSO automatically.
  // Silent when the Citadel session is active; otherwise shows the Citadel login.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('redirect_url')) {
      void onCitadel();
    }
  }, [onCitadel]);

  return (
    <AuthShell>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-stone-900">Welcome back</h1>
        <p className="mb-6 text-sm text-stone-600">Sign in to see how your inboxes are doing.</p>
        <Suspense fallback={null}>
          <ResetNotice />
        </Suspense>

        <button
          type="button"
          onClick={onCitadel}
          disabled={busy}
          className="mb-4 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Redirecting to WebNCO ID…' : 'Continue with WebNCO ID'}
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-stone-400">
          <span className="h-px flex-1 bg-stone-200" />
          or with email
          <span className="h-px flex-1 bg-stone-200" />
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <p className="text-right text-xs">
            <Link href="/forgot-password" className="text-brand-600 hover:underline">
              Forgot your password?
            </Link>
          </p>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        </form>

        <p className="mt-6 text-center text-sm text-stone-600">
          New here?{' '}
          <Link href="/sign-up" className="font-medium text-brand-600 hover:underline">
            Create an account
          </Link>
        </p>
      </AuthShell>
  );
}
