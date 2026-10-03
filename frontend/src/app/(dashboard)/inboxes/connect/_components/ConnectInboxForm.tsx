'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { useToasts } from '@/components/Toast';
import {
  ProviderQuickFill,
  ProviderAppPasswordNote,
  SmtpPortChips,
  errorHint,
  type Provider,
} from '@/app/(dashboard)/_components/SmtpFormHints';

type Tab = 'gmail' | 'outlook' | 'custom';

// The API owns the OAuth client and the single-use state. This form asks it
// for the provider URL and sends the browser there; the provider returns to
// /api/mailbox-oauth/callback/{google,microsoft}, which completes the link
// for the signed-in user and comes back here (with `link_error`) or to /inboxes.

const LINK_ERRORS: Record<string, string> = {
  denied: 'Access to the mailbox was not granted, so nothing was connected.',
  state_invalid: 'That connection attempt expired or was already used. Please start again.',
  provider_error: 'The mail provider did not complete the connection. Please try again.',
  duplicate: 'This mailbox is already connected to another account.',
  limit: 'You have reached the inbox limit for your plan.',
  connection_failed:
    'Access was granted, but the mailbox did not pass the connection check. Make sure IMAP is enabled for it, then try again.',
};

export function ConnectInboxForm() {
  const [tab, setTab] = useState<Tab>('gmail');
  // Joining the shared pool is the owner's explicit choice, never a default.
  const [poolConsent, setPoolConsent] = useState(false);
  const linkError = useSearchParams().get('link_error');
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {linkError ? (
        <div
          role="alert"
          className="rounded-t-2xl border-b border-red-200 bg-red-50 px-6 py-3 text-sm text-red-800"
        >
          {LINK_ERRORS[linkError] ?? LINK_ERRORS.provider_error}
        </div>
      ) : null}
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
        {tab === 'gmail' ? <GmailConnect poolConsent={poolConsent} /> : null}
        {tab === 'outlook' ? <OutlookConnect poolConsent={poolConsent} /> : null}
        {tab === 'custom' ? <CustomSmtpForm poolConsent={poolConsent} /> : null}
        <PoolConsentField checked={poolConsent} onChange={setPoolConsent} />
      </div>
    </div>
  );
}

function PoolConsentField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span className="text-sm text-slate-700">
          <span className="font-medium text-slate-900">Join the shared warmup pool</span>
          <span className="mt-1 block text-slate-600">
            This inbox will exchange automated warmup emails with other customers’ inboxes: it
            sends to them, and it automatically opens, stars, replies to and files the warmup
            emails it receives into a “WarmupHub” folder. Leave this off to warm only against
            your own private pool. You can change it later from the inbox page.
          </span>
        </span>
      </label>
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

function GmailConnect({ poolConsent }: { poolConsent: boolean }) {
  const api = useApi();
  const { show } = useToasts();
  const [busy, setBusy] = useState(false);

  async function startGmail() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(
        `/auth/gmail/connect?poolConsent=${poolConsent}`,
      );
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

function OutlookConnect({ poolConsent }: { poolConsent: boolean }) {
  const api = useApi();
  const { show } = useToasts();
  const [busy, setBusy] = useState(false);

  async function startOutlook() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(
        `/auth/outlook/connect?poolConsent=${poolConsent}`,
      );
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

function CustomSmtpForm({ poolConsent }: { poolConsent: boolean }) {
  const api = useApi();
  const router = useRouter();
  const { show } = useToasts();
  const [busy, setBusy] = useState(false);
  // IMAP is optional. When the user ticks the "use IMAP" box we render
  // the IMAP fields and require them; otherwise we send useImap: false
  // and the backend stores NULL IMAP columns. The inbox can still send
  // via SMTP — receive/reply/placement paths no-op gracefully.
  const [useImap, setUseImap] = useState(false);

  // T028: quick-fill provider state + controlled SMTP host/port + IMAP
  // host/port so the `<ProviderQuickFill />` chip row can write into the
  // form. Email, password, and DKIM selector stay uncontrolled.
  const [provider, setProvider] = useState<Provider>('custom');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState<number>(587);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState<number>(993);
  // Last connect attempt result — drives the inline ✓/✗ result block
  // (T028 §5). `precheck` holds the success shape (SmtpClientService /
  // ImapClientService detail from `runPrecheck`'s `detail` field);
  // `connectError` holds the structured failure shape parsed from the
  // backend's 422 body (`{step, error, errCode, host, port}`).
  type PrecheckDetail = { ok: boolean; host?: string; port?: number; ms: number; mailboxCount?: number };
  const [precheck, setPrecheck] = useState<{
    smtp?: PrecheckDetail;
    imap?: PrecheckDetail;
  } | null>(null);
  const [connectError, setConnectError] = useState<{
    step: string | null;
    errCode: string | null;
    host: string | null;
    port: number | null;
    message: string;
  } | null>(null);

  function applyProviderPreset(preset: {
    smtpHost: string;
    smtpPort: number;
    imapHost: string;
    imapPort: number;
  }) {
    setSmtpHost(preset.smtpHost);
    setSmtpPort(preset.smtpPort);
    setImapHost(preset.imapHost);
    setImapPort(preset.imapPort);
    setUseImap(true); // turning on IMAP makes the provider usable
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const payload: Record<string, unknown> = {
      email: String(data.get('email') ?? ''),
      smtpHost,
      smtpPort,
      smtpUser: String(data.get('smtpUser') ?? ''),
      smtpPassword: String(data.get('smtpPassword') ?? ''),
      useImap,
      poolConsent,
      dkimSelector: (data.get('dkimSelector') as string) || undefined,
    };
    if (useImap) {
      payload.imapHost = imapHost;
      payload.imapPort = imapPort;
      payload.imapUser = String(data.get('imapUser') ?? '');
      payload.imapPassword = String(data.get('imapPassword') ?? '');
    }

    setBusy(true);
    setConnectError(null);
    setPrecheck(null);
    try {
      const res = await api<{ precheck?: { detail?: { smtp?: PrecheckDetail; imap?: PrecheckDetail } } }>(
        '/inboxes/connect/smtp',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
      setPrecheck(res.precheck?.detail ?? null);
      show('Inbox connected — running pre-check.', 'success');
      setTimeout(() => router.push('/inboxes'), 1200);
    } catch (e) {
      const apiErr = e instanceof ApiError ? e : null;
      // The 422 body from `connectCustomSmtp` is a JSON object
      // (`{step, error, errCode, host, port}`) — `ApiError.body` only
      // extracts a `message` field, which this shape doesn't have, so
      // it falls back to the raw JSON text. Parse it back out here to
      // get the structured fields for `errorHint()`.
      let parsed: { step?: string; error?: string; errCode?: string; host?: string; port?: number } | null =
        null;
      if (apiErr) {
        try {
          parsed = JSON.parse(apiErr.body);
        } catch {
          parsed = null;
        }
      }
      const msg = parsed?.error ?? apiErr?.body ?? (e instanceof Error ? e.message : 'Failed to connect inbox');
      setConnectError({
        step: parsed?.step ?? null,
        errCode: parsed?.errCode ?? null,
        host: parsed?.host ?? null,
        port: parsed?.port ?? null,
        message: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Custom SMTP / IMAP</h2>

      {/* T028: provider quick-fill chips + App Password hint */}
      <ProviderQuickFill
        current={provider}
        onPick={(p) => {
          setProvider(
            // Map by host to keep the right chip active
            p.smtpHost.includes('gmail')
              ? 'gmail'
              : p.smtpHost.includes('outlook')
                ? 'outlook'
                : p.smtpHost.includes('yahoo')
                  ? 'yahoo'
                  : 'zoho',
          );
          applyProviderPreset(p);
        }}
        onCustom={() => {
          setProvider('custom');
        }}
      />
      <ProviderAppPasswordNote provider={provider} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Email address" name="email" type="email" required className="sm:col-span-2" />
        <Field
          label="SMTP host"
          name="smtpHost"
          required
          value={smtpHost}
          onChange={(v) => setSmtpHost(v)}
        />
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-700" htmlFor="smtpPort">
            SMTP port
          </label>
          <SmtpPortChips name="smtpPort" value={smtpPort} onChange={setSmtpPort} />
          <input
            id="smtpPort"
            type="number"
            value={smtpPort}
            onChange={(e) => setSmtpPort(Number(e.target.value || 587))}
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            placeholder="Or type a custom port"
            min={1}
            max={65535}
          />
        </div>
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
          <Field
            label="IMAP host"
            name="imapHost"
            required
            value={imapHost}
            onChange={(v) => setImapHost(v)}
          />
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700" htmlFor="imapPort">
              IMAP port
            </label>
            <input
              id="imapPort"
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(Number(e.target.value || 993))}
              className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              min={1}
              max={65535}
            />
          </div>
          <Field label="IMAP user" name="imapUser" required />
          <Field label="IMAP password" name="imapPassword" type="password" required />
        </div>
      ) : null}

      {precheck ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {precheck.smtp ? (
            <p>
              ✓ SMTP connected{' '}
              {precheck.smtp.host ? (
                <span className="font-mono">
                  ({precheck.smtp.host}:{precheck.smtp.port} responded in {precheck.smtp.ms}ms)
                </span>
              ) : null}
            </p>
          ) : null}
          {precheck.imap ? (
            <p>
              ✓ IMAP connected{' '}
              {precheck.imap.host ? (
                <span className="font-mono">
                  ({precheck.imap.host}:{precheck.imap.port}, {precheck.imap.mailboxCount ?? 0}{' '}
                  mailboxes found)
                </span>
              ) : null}
            </p>
          ) : null}
          <p>✓ Pre-check passed — inbox added</p>
        </div>
      ) : null}

      {connectError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          <p className="font-semibold">
            ✗ {connectError.step === 'imap' ? 'IMAP' : 'SMTP'} failed
            {connectError.errCode ? <span className="font-mono"> {connectError.errCode}</span> : null}
            {' — '}
            {connectError.message}
          </p>
          {(() => {
            const hint = errorHint(
              connectError.errCode,
              connectError.host ?? undefined,
              connectError.port ?? undefined,
            );
            return hint ? <p className="mt-1 text-rose-700">→ {hint}</p> : null;
          })()}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect inbox'}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  value,
  onChange,
  className,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  value?: string;
  onChange?: (next: string) => void;
  className?: string;
}) {
  return (
    <label className={`block text-sm ${className ?? ''}`}>
      <span className="text-xs font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
      />
    </label>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84c-.21 1.12-.85 2.07-1.81 2.71v2.26h2.92c1.71-1.58 2.69-3.9 2.69-6.62z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.97 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.16.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.33z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <rect width="8" height="8" fill="#F25022" />
      <rect x="9" width="8" height="8" fill="#7FBA00" />
      <rect y="9" width="8" height="8" fill="#00A4EF" />
      <rect x="9" y="9" width="8" height="8" fill="#FFB900" />
    </svg>
  );
}
