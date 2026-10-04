'use client';

import { Suspense, useState } from 'react';
import { AuthShell } from '@/components/brand/AuthShell';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth';

const MIN_LENGTH = 8;

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token');
  const linkProblem = params.get('error');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token || linkProblem) {
    return (
      <p role="alert" className="mt-4 text-sm text-rose-700">
        This reset link is no longer valid. It may have expired or already been used.{' '}
        <Link href="/forgot-password" className="text-brand-600 hover:underline">
          Request a new one
        </Link>
        .
      </p>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient
      .resetPassword({ newPassword: password, token: token! })
      .catch((err: unknown) => ({ error: { message: (err as Error)?.message } }));
    if (result?.error) {
      setError(
        'We could not set a new password with this link. It may have expired or already been used. Request a new one and try again.',
      );
      setBusy(false);
      return;
    }
    router.push('/sign-in?reset=1');
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-3">
      <label htmlFor="new-password" className="block text-sm text-stone-600">
        New password (at least {MIN_LENGTH} characters)
      </label>
      <input
        id="new-password"
        type="password"
        required
        minLength={MIN_LENGTH}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
      />
      {error ? (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Set new password'}
      </button>
      <p className="text-xs text-stone-500">
        Setting a new password signs you out on every device.
      </p>
    </form>
  );
}

export default function Page() {
  return (
    <AuthShell>
        <h1 className="text-2xl font-semibold text-stone-900">Choose a new password</h1>
        <Suspense fallback={null}>
          <ResetForm />
        </Suspense>
      </AuthShell>
  );
}
