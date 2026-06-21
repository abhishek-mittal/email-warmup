'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

type Tab = 'gmail' | 'outlook' | 'custom';

// Backend owns the OAuth client_id/secret + state encoding. Frontend just
// fetches the Google/Microsoft URL it should redirect to, then bounces the
// browser there. Backend's /auth/callback/{google,microsoft} handles the
// code exchange + token encryption + inbox creation, then redirects to /inboxes.

export function ConnectInboxForm() {
  const [tab, setTab] = useState<Tab>('gmail');
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex border-b border-slate-200">
        <TabButton active={tab === 'gmail'} onClick={() => setTab('gmail')}>
          Gmail
        </TabButton>
        <TabButton active={tab === 'outlook'} onClick={() => setTab('outlook')}>
          Outlook
        </TabButton>
        <TabButton active={tab === 'custom'} onClick={() => setTab('custom')}>
          Custom SMTP
        </TabButton>
      </div>
      <div className="p-6">
        {tab === 'gmail' ? <GmailConnect /> : null}
        {tab === 'outlook' ? <OutlookConnect /> : null}
        {tab === 'custom' ? <CustomSmtpForm /> : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-5 py-3 text-sm font-medium transition-colors ${
        active
          ? 'border-b-2 border-indigo-600 text-indigo-700'
          : 'border-b-2 border-transparent text-slate-600 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}

function GmailConnect() {
  const api = useApi();
  const { show } = useToasts();
  const [busy, setBusy] = useState(false);

  async function startGmail() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/auth/gmail/connect');
      window.location.href = url;
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to start Google connect';
      show(msg || 'Failed to start Google connect', 'error');
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Connect with Google</h2>
      <p className="text-sm text-slate-600">
        We request Gmail send + read access to run warmup traffic. Tokens are encrypted at rest
        with AES-256-GCM and never shared.
      </p>
      <button
        type="button"
        onClick={startGmail}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
      >
        <GoogleMark /> {busy ? 'Redirecting…' : 'Connect with Google'}
      </button>
    </div>
  );
}

function OutlookConnect() {
  const api = useApi();
  const { show } = useToasts();
  const [busy, setBusy] = useState(false);

  async function startOutlook() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/auth/outlook/connect');
      window.location.href = url;
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to start Microsoft connect';
      show(msg || 'Failed to start Microsoft connect', 'error');
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Connect with Microsoft</h2>
      <p className="text-sm text-slate-600">
        We request Mail send + read access for warmup. Tokens are encrypted with AES-256-GCM at
        rest.
      </p>
      <button
        type="button"
        onClick={startOutlook}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
      >
        <MicrosoftMark /> {busy ? 'Redirecting…' : 'Connect with Microsoft'}
      </button>
    </div>
  );
}

function CustomSmtpForm() {
  const api = useApi();
  const router = useRouter();
  const { toast, show, clear } = useToasts();
  const [busy, setBusy] = useState(false);
  // IMAP is optional. When the user ticks the "use IMAP" box we render
  // the IMAP fields and require them; otherwise we send useImap: false
  // and the backend stores NULL IMAP columns. The inbox can still send
  // via SMTP — receive/reply/placement paths no-op gracefully.
  const [useImap, setUseImap] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const payload: Record<string, unknown> = {
      email: String(data.get('email') ?? ''),
      smtpHost: String(data.get('smtpHost') ?? ''),
      smtpPort: Number(data.get('smtpPort') ?? 587),
      smtpUser: String(data.get('smtpUser') ?? ''),
      smtpPassword: String(data.get('smtpPassword') ?? ''),
      useImap,
      dkimSelector: (data.get('dkimSelector') as string) || undefined,
    };
    if (useImap) {
      payload.imapHost = String(data.get('imapHost') ?? '');
      payload.imapPort = Number(data.get('imapPort') ?? 993);
      payload.imapUser = String(data.get('imapUser') ?? '');
      payload.imapPassword = String(data.get('imapPassword') ?? '');
    }

    setBusy(true);
    try {
      await api('/inboxes/connect/smtp', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      show('Inbox connected — running pre-check.', 'success');
      router.push('/inboxes');
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to connect inbox';
      show(msg || 'Failed to connect inbox', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Custom SMTP / IMAP</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Email address" name="email" type="email" required className="sm:col-span-2" />
        <Field label="SMTP host" name="smtpHost" required />
        <Field label="SMTP port" name="smtpPort" type="number" defaultValue="587" required />
        <Field label="SMTP user" name="smtpUser" required />
        <Field label="SMTP password" name="smtpPassword" type="password" required />
        <Field label="DKIM selector (optional)" name="dkimSelector" className="sm:col-span-2" />
      </div>

      <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        <input
          type="checkbox"
          checked={useImap}
          onChange={(e) => setUseImap(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span>
          <span className="block font-medium text-slate-900">Also configure IMAP (recommended)</span>
          <span className="block text-xs text-slate-600">
            IMAP lets us open, reply to, and rescue-from-spam the warmup emails we send
            you, and is required to join the warmup pool. Leave unchecked if your SMTP
            provider does not expose IMAP — sending will still work.
          </span>
        </span>
      </label>

      {useImap ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="IMAP host" name="imapHost" required />
          <Field label="IMAP port" name="imapPort" type="number" defaultValue="993" required />
          <Field label="IMAP user" name="imapUser" required />
          <Field label="IMAP password" name="imapPassword" type="password" required />
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect inbox'}
      </button>
      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  className,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  className?: string;
}) {
  return (
    <label className={`block text-sm ${className ?? ''}`}>
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
    </label>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#fff"
        d="M21.35 11.1H12v2.8h5.4c-.25 1.4-1.7 4.1-5.4 4.1-3.25 0-5.9-2.7-5.9-6s2.65-6 5.9-6c1.85 0 3.1.8 3.8 1.45l2.6-2.5C16.7 3.4 14.55 2.5 12 2.5 6.85 2.5 2.65 6.7 2.65 11.85s4.2 9.35 9.35 9.35c5.4 0 9-3.8 9-9.15 0-.6-.05-1.05-.15-1.95z"
      />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <rect width="9" height="9" x="2" y="2" fill="#fff" />
      <rect width="9" height="9" x="13" y="2" fill="#fff" />
      <rect width="9" height="9" x="2" y="13" fill="#fff" />
      <rect width="9" height="9" x="13" y="13" fill="#fff" />
    </svg>
  );
}
