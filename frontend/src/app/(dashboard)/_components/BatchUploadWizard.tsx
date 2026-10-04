'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';
import {
  ProviderQuickFill,
  ProviderAppPasswordNote,
  SmtpPortChips,
  errorHint,
  type Provider as HintProvider,
} from './SmtpFormHints';

type Provider = 'gmail' | 'outlook' | 'custom';

interface BatchEntry {
  email: string;
  provider: Provider;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
}

const EMPTY_FORM: BatchEntry = {
  email: '',
  provider: 'gmail',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPassword: '',
  imapHost: '',
  imapPort: 993,
  imapUser: '',
  imapPassword: '',
};

/** Returns a human-readable missing-fields reason, or null if the entry is
 * complete enough to add. Mirrors `validateBatchEntry` in
 * `backend/src/inbox/inbox.service.ts`'s required-field rules. */
function validateEntry(entry: BatchEntry): string | null {
  if (!entry.email) return 'Email is required';
  if (entry.provider === 'gmail' || entry.provider === 'outlook') {
    const missing: string[] = [];
    if (!entry.clientId) missing.push('Client ID');
    if (!entry.clientSecret) missing.push('Client secret');
    if (!entry.refreshToken) missing.push('Refresh token');
    if (missing.length > 0) return `Missing: ${missing.join(', ')}`;
    return null;
  }
  const missing: string[] = [];
  if (!entry.smtpHost) missing.push('SMTP host');
  if (!entry.smtpPort) missing.push('SMTP port');
  if (!entry.smtpUser) missing.push('SMTP user');
  if (!entry.smtpPassword) missing.push('SMTP password');
  if (!entry.imapHost) missing.push('IMAP host');
  if (!entry.imapPort) missing.push('IMAP port');
  if (!entry.imapUser) missing.push('IMAP user');
  if (!entry.imapPassword) missing.push('IMAP password');
  if (missing.length > 0) return `Missing: ${missing.join(', ')}`;
  return null;
}

const KNOWN_ERROR_CODES = ['EAUTH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'IMAP_EAUTH'];

/** Pulls a known errCode out of a free-text `failed[].reason` string (if
 *  present) and maps it through the shared `errorHint()` helper so batch
 *  failures get the same plain-English fix hints as the connect form. */
function hintForReason(reason: string): string | null {
  const code = KNOWN_ERROR_CODES.find((c) => reason.includes(c));
  return code ? errorHint(code) : null;
}

function toApiEntry(entry: BatchEntry): Record<string, unknown> {
  if (entry.provider === 'gmail' || entry.provider === 'outlook') {
    return {
      email: entry.email,
      provider: entry.provider,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      refreshToken: entry.refreshToken,
    };
  }
  return {
    email: entry.email,
    provider: 'custom',
    smtpHost: entry.smtpHost,
    smtpPort: Number(entry.smtpPort),
    smtpUser: entry.smtpUser,
    smtpPassword: entry.smtpPassword,
    imapHost: entry.imapHost,
    imapPort: Number(entry.imapPort),
    imapUser: entry.imapUser,
    imapPassword: entry.imapPassword,
  };
}

interface Props {
  endpoint: '/inboxes/batch' | '/pool-inboxes/batch';
  label?: string;
  /** Called after a successful upload so the parent can start polling
   *  for the analysis rows to appear (the actual DNS / OAuth analysis
   *  runs async in a BullMQ worker — `router.refresh()` alone fires
   *  before the result is in the DB). */
  onUploaded?: () => void;
}

export function BatchUploadWizard({ endpoint, label = 'Add via wizard', onUploaded }: Props) {
  const api = useApi();
  const router = useRouter();
  const { toast, show, clear } = useToasts();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BatchEntry>(EMPTY_FORM);
  const [collected, setCollected] = useState<BatchEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-row failures from the last submit, e.g. a duplicate email or a
  // missing-field error keyed by errCode-like substrings (EAUTH /
  // ECONNREFUSED / etc.) the backend may include in `reason` — mapped
  // through the same `errorHint()` the connect form uses (T028 §5).
  const [submitFailures, setSubmitFailures] = useState<{ email: string; reason: string }[]>([]);

  function closeModal() {
    setOpen(false);
    setForm(EMPTY_FORM);
    setCollected([]);
    setError(null);
    setSubmitFailures([]);
  }

  function update<K extends keyof BatchEntry>(key: K, value: BatchEntry[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addAnother() {
    const reason = validateEntry(form);
    if (reason) {
      setError(reason);
      return;
    }
    setCollected((c) => [...c, form]);
    setForm({ ...EMPTY_FORM, provider: form.provider });
    setError(null);
  }

  async function finishAndSubmit() {
    let finalList = collected;
    // If the current form has *something* filled in, validate and include
    // it too — otherwise the user would lose a half-finished last entry.
    const hasContent = form.email.trim() !== '';
    if (hasContent) {
      const reason = validateEntry(form);
      if (reason) {
        setError(reason);
        return;
      }
      finalList = [...collected, form];
    }

    if (finalList.length === 0) {
      setError('Add at least one inbox before submitting.');
      return;
    }

    setBusy(true);
    setError(null);
    setSubmitFailures([]);
    try {
      const res = await api<{ created: number; failed: { email: string; reason: string }[] }>(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify({ inboxes: finalList.map(toApiEntry) }),
        },
      );
      show(`${res.created} added successfully, ${res.failed.length} failed.`, res.failed.length ? 'info' : 'success');
      // Tell the parent page to start polling for the analysis rows —
      // the actual DNS / OAuth analysis is async (BullMQ worker, takes
      // a few seconds) so a plain `router.refresh()` here would re-fetch
      // before any `inbox_analysis` rows exist.
      onUploaded?.();
      router.refresh();
      if (res.failed.length > 0) {
        // Keep the modal open so the user can see which rows failed and
        // why, instead of silently closing on a partial success.
        setSubmitFailures(res.failed);
        setCollected(finalList);
        setForm({ ...EMPTY_FORM, provider: form.provider });
      } else {
        closeModal();
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to submit batch';
      show(msg || 'Failed to submit batch', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
      >
        {label}
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-stone-900/40 p-4">
          <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-stone-900">Add via wizard</h2>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
              >
                ✕
              </button>
            </div>

            {collected.length > 0 ? (
              <p className="mt-2 text-sm text-stone-600">
                {collected.length} inbox{collected.length === 1 ? '' : 'es'} queued: {collected.map((c) => c.email).join(', ')}
              </p>
            ) : null}

            <div className="mt-4 flex gap-2">
              {(['gmail', 'outlook', 'custom'] as Provider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => update('provider', p)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                    form.provider === p
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-stone-300 text-stone-700 hover:bg-stone-50'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* T028: provider quick-fill chips for the SMTP/IMAP host + port
                when "custom" is selected. Auto-fills SMTP + IMAP host/port
                so the user doesn't have to memorize them. Email/password
                stay user-supplied. */}
            {form.provider === 'custom' ? (
              <div className="mt-3 space-y-2">
                <ProviderQuickFill
                  current="custom"
                  onPick={(p) => {
                    update('smtpHost', p.smtpHost);
                    update('smtpPort', p.smtpPort);
                    update('imapHost', p.imapHost);
                    update('imapPort', p.imapPort);
                  }}
                  onCustom={() => {
                    /* no-op: already custom */
                  }}
                />
                <p className="text-xs text-stone-500">
                  Pick a provider above to pre-fill the SMTP and IMAP hostnames + ports —
                  you still enter the email and password.
                </p>
              </div>
            ) : null}

            {/* T028: App Password note when Gmail / Outlook is selected */}
            <div className="mt-3">
              <ProviderAppPasswordNote
                provider={(form.provider === 'gmail' || form.provider === 'outlook'
                  ? form.provider
                  : 'custom') as HintProvider}
              />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Email address"
                value={form.email}
                onChange={(v) => update('email', v)}
                className="sm:col-span-2"
              />
              {form.provider === 'gmail' || form.provider === 'outlook' ? (
                <>
                  <Field
                    label="Client ID"
                    value={form.clientId ?? ''}
                    onChange={(v) => update('clientId', v)}
                  />
                  <Field
                    label="Client secret"
                    type="password"
                    value={form.clientSecret ?? ''}
                    onChange={(v) => update('clientSecret', v)}
                  />
                  <Field
                    label="Refresh token"
                    type="password"
                    value={form.refreshToken ?? ''}
                    onChange={(v) => update('refreshToken', v)}
                    className="sm:col-span-2"
                  />
                </>
              ) : (
                <>
                  <Field label="SMTP host" value={form.smtpHost ?? ''} onChange={(v) => update('smtpHost', v)} />
                  <div className="space-y-1.5">
                    <span className="mb-1 block text-xs font-medium text-stone-700">SMTP port</span>
                    <SmtpPortChips
                      name="smtpPort"
                      value={form.smtpPort ?? 587}
                      onChange={(v) => update('smtpPort', v)}
                    />
                  </div>
                  <Field label="SMTP user" value={form.smtpUser ?? ''} onChange={(v) => update('smtpUser', v)} />
                  <Field
                    label="SMTP password"
                    type="password"
                    value={form.smtpPassword ?? ''}
                    onChange={(v) => update('smtpPassword', v)}
                  />
                  <Field label="IMAP host" value={form.imapHost ?? ''} onChange={(v) => update('imapHost', v)} />
                  <Field
                    label="IMAP port"
                    type="number"
                    value={String(form.imapPort ?? '')}
                    onChange={(v) => update('imapPort', Number(v))}
                  />
                  <Field label="IMAP user" value={form.imapUser ?? ''} onChange={(v) => update('imapUser', v)} />
                  <Field
                    label="IMAP password"
                    type="password"
                    value={form.imapPassword ?? ''}
                    onChange={(v) => update('imapPassword', v)}
                  />
                </>
              )}
            </div>

            {error ? (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                <p className="font-semibold">Couldn&rsquo;t add this entry</p>
                <p className="mt-1">{error}</p>
              </div>
            ) : null}

            {submitFailures.length > 0 ? (
              <div className="mt-3 space-y-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                <p className="font-semibold">
                  {submitFailures.length} entr{submitFailures.length === 1 ? 'y' : 'ies'} failed
                </p>
                {submitFailures.map((f, idx) => {
                  const hint = hintForReason(f.reason);
                  return (
                    <div key={`${f.email}-${idx}`} className="border-t border-rose-200/60 pt-1.5 first:border-t-0 first:pt-0">
                      <p>
                        <span className="font-mono">{f.email}</span> — {f.reason}
                      </p>
                      {hint ? <p className="mt-0.5 text-rose-700">→ {hint}</p> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={addAnother}
                className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
              >
                Add another
              </button>
              <button
                type="button"
                onClick={finishAndSubmit}
                disabled={busy}
                className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? 'Submitting…' : 'Done'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  className?: string;
}) {
  return (
    <label className={`block text-sm ${className ?? ''}`}>
      <span className="mb-1 block text-xs font-medium text-stone-700">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    </label>
  );
}
