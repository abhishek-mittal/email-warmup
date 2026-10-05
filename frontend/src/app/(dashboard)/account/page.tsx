'use client';

import { useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { signOut } from '@/lib/auth';
import { useToasts } from '@/components/Toast';

/**
 * Account page: download your data, or delete the account. Deletion asks
 * for the account email, typed, before anything happens.
 */
export default function AccountPage() {
  const api = useApi();
  const { show } = useToasts();
  const [exported, setExported] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function exportData() {
    setExporting(true);
    try {
      const data = await api<unknown>('/account/export');
      setExported(JSON.stringify(data, null, 2));
    } catch (e) {
      show(e instanceof ApiError ? e.body : 'Could not export your data', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function copyExport() {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported);
      show('Copied to clipboard.', 'success');
    } catch {
      show('Select the text and copy it manually.', 'error');
    }
  }

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    try {
      await api('/account/delete', { method: 'POST', body: JSON.stringify({ confirmEmail }) });
      await signOut().catch(() => undefined);
      window.location.href = '/sign-in';
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.body : 'Could not delete the account');
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Account</h1>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-stone-900">Your data</h2>
        <p className="mt-1 text-sm text-stone-600">
          Everything we hold about your account, inboxes and warmup emails, as JSON. Saved
          passwords and tokens are never included.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={exportData}
            disabled={exporting}
            className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {exporting ? 'Preparing…' : 'Show my data'}
          </button>
          {exported ? (
            <button
              type="button"
              onClick={copyExport}
              className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50"
            >
              Copy
            </button>
          ) : null}
        </div>
        {exported ? (
          <textarea
            id="account-export"
            readOnly
            value={exported}
            aria-label="Your exported data"
            className="mt-4 h-64 w-full rounded-lg border border-stone-200 bg-stone-50 p-3 font-mono text-xs text-stone-800"
          />
        ) : null}
      </section>

      <section className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-rose-800">Delete account</h2>
        <p className="mt-1 text-sm text-stone-600">
          This stops all warmup, erases your saved credentials, removes your email addresses, mail
          server details, diagnostics and sign-in, and signs you out everywhere. It cannot be
          undone. Anonymous delivery records (no addresses or subjects) are kept so other
          customers’ statistics stay correct.
        </p>
        <form onSubmit={deleteAccount} className="mt-4 space-y-3">
          <label htmlFor="confirm-email" className="block text-sm font-medium text-stone-800">
            Type your account email to confirm
          </label>
          <input
            id="confirm-email"
            type="email"
            required
            autoComplete="off"
            value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none"
          />
          {deleteError ? (
            <p role="alert" className="text-sm text-rose-700">
              {deleteError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={deleting || confirmEmail.length === 0}
            className="rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete my account'}
          </button>
        </form>
      </section>
    </div>
  );
}
