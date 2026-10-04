'use client';

import { useState } from 'react';
import { AuthShell } from '@/components/brand/AuthShell';
import Link from 'next/link';
import { authClient } from '@/lib/auth';

export default function Page() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
    } catch {
      // Same outcome either way: never reveal whether the address has an account.
    }
    setSent(true);
    setBusy(false);
  }

  return (
    <AuthShell>
        <h1 className="mb-1 text-2xl font-semibold text-stone-900">Reset your password</h1>
        {sent ? (
          <p role="status" className="mt-4 text-sm text-stone-600">
            If an account exists for <strong>{email}</strong>, we sent it a link to choose a new
            password. The link works once and expires in 30 minutes.
          </p>
        ) : (
          <>
            <p className="mb-6 text-sm text-stone-600">
              Enter your account email and we will send you a link to choose a new password.
            </p>
            <form onSubmit={onSubmit} className="space-y-3">
              <label htmlFor="forgot-email" className="sr-only">
                Email address
              </label>
              <input
                id="forgot-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}
        <p className="mt-6 text-center text-sm text-stone-600">
          <Link href="/sign-in" className="text-brand-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </AuthShell>
  );
}
