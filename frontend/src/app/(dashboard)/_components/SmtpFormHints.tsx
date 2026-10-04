'use client';

/**
 * T028 §5 — connection hints for the Custom SMTP form.
 *
 * Exports:
 *  - `<ProviderQuickFill />` — button row that auto-fills SMTP + IMAP
 *    host/port for Gmail/Outlook/Yahoo/Zoho. Does NOT touch email,
 *    password, or DKIM selector (those are user-specific).
 *  - `<SmtpPortChips />` — replaces the bare port number input with
 *    three common chips (587 TLS / 465 SSL / 25) plus a free-text
 *    fallback. The current port value drives which chip is highlighted.
 *  - `<ProviderAppPasswordNote />` — per-provider copy about App
 *    Passwords (Gmail/Outlook/Yahoo) shown after the user clicks
 *    quick-fill.
 *  - `errorHint(errCode, host, port)` — maps known SMTP/IMAP error
 *    codes to plain-English fixes.
 *
 * All four pieces are stateless — the parent form owns the values via
 * `useState`/`useRef`. The components accept the field name and a
 * setter so they write into the right input by name.
 */

export type Provider = 'gmail' | 'outlook' | 'yahoo' | 'zoho' | 'custom';

export interface ProviderConfig {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export const PROVIDER_PRESETS: Record<Exclude<Provider, 'custom'>, ProviderConfig> = {
  gmail: {
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
  },
  outlook: {
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
  },
  yahoo: {
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 587,
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
  },
  zoho: {
    smtpHost: 'smtp.zoho.com',
    smtpPort: 587,
    imapHost: 'imap.zoho.com',
    imapPort: 993,
  },
};

/**
 * Zoho runs a separate mail cluster per data center, each with its own
 * SMTP/IMAP hostname. A mailbox created in (say) the EU DC will reject
 * logins against `smtp.zoho.com` (US) outright, so picking the wrong region
 * is a common "wrong password" false alarm. Ports are the same everywhere
 * (SMTP 587 STARTTLS, IMAP 993 TLS); only the host suffix changes.
 *
 * Your DC is shown at Zoho Mail → Settings, or inferred from the sign-in URL
 * (mail.zoho.eu → EU, mail.zoho.in → IN, …).
 */
export const ZOHO_REGIONS: Array<{ key: string; label: string; config: ProviderConfig }> = [
  { key: 'com', label: 'US / Global (.com)', config: { smtpHost: 'smtp.zoho.com', smtpPort: 587, imapHost: 'imap.zoho.com', imapPort: 993 } },
  { key: 'eu', label: 'Europe (.eu)', config: { smtpHost: 'smtp.zoho.eu', smtpPort: 587, imapHost: 'imap.zoho.eu', imapPort: 993 } },
  { key: 'in', label: 'India (.in)', config: { smtpHost: 'smtp.zoho.in', smtpPort: 587, imapHost: 'imap.zoho.in', imapPort: 993 } },
  { key: 'au', label: 'Australia (.com.au)', config: { smtpHost: 'smtp.zoho.com.au', smtpPort: 587, imapHost: 'imap.zoho.com.au', imapPort: 993 } },
  { key: 'jp', label: 'Japan (.jp)', config: { smtpHost: 'smtp.zoho.jp', smtpPort: 587, imapHost: 'imap.zoho.jp', imapPort: 993 } },
  { key: 'ca', label: 'Canada (zohocloud.ca)', config: { smtpHost: 'smtp.zohocloud.ca', smtpPort: 587, imapHost: 'imap.zohocloud.ca', imapPort: 993 } },
  { key: 'sa', label: 'Saudi Arabia (.sa)', config: { smtpHost: 'smtp.zoho.sa', smtpPort: 587, imapHost: 'imap.zoho.sa', imapPort: 993 } },
  { key: 'cn', label: 'China (.com.cn)', config: { smtpHost: 'smtp.zoho.com.cn', smtpPort: 587, imapHost: 'imap.zoho.com.cn', imapPort: 993 } },
];

interface QuickFillProps {
  /** Called when the user clicks a provider chip. Receives the preset
   *  values; parent writes them into the relevant form fields. */
  onPick: (preset: ProviderConfig) => void;
  onCustom: () => void;
  /** Currently-selected provider (so the active chip can be highlighted). */
  current: Provider;
}

export function ProviderQuickFill({ onPick, onCustom, current }: QuickFillProps) {
  const chips: Array<{ key: Provider; label: string }> = [
    { key: 'gmail', label: 'Gmail' },
    { key: 'outlook', label: 'Outlook' },
    { key: 'yahoo', label: 'Yahoo' },
    { key: 'zoho', label: 'Zoho' },
    { key: 'custom', label: 'Custom' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-stone-600">Fill settings for:</span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() =>
            c.key === 'custom'
              ? onCustom()
              : onPick(PROVIDER_PRESETS[c.key as Exclude<Provider, 'custom'>])
          }
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            current === c.key
              ? 'border-brand-500 bg-brand-50 text-brand-700'
              : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
          }`}
          data-testid={`provider-fill-${c.key}`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

interface PortChipsProps {
  /** Hidden input name so the parent form picks up the value on submit. */
  name: string;
  value: number | string;
  onChange: (next: number) => void;
}

const COMMON_PORTS: Array<{ port: number; label: string }> = [
  { port: 587, label: '587 TLS' },
  { port: 465, label: '465 SSL' },
  { port: 25, label: '25' },
];

export function SmtpPortChips({ name, value, onChange }: PortChipsProps) {
  const numValue = typeof value === 'number' ? value : Number(value);
  const matched = COMMON_PORTS.some((p) => p.port === numValue);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="hidden" name={name} value={value} />
      <span className="text-xs font-medium text-stone-600">SMTP port:</span>
      {COMMON_PORTS.map((p) => (
        <button
          key={p.port}
          type="button"
          onClick={() => onChange(p.port)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            numValue === p.port
              ? 'border-brand-500 bg-brand-50 text-brand-700'
              : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
          }`}
        >
          {p.label}
        </button>
      ))}
      {!matched ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800">
          Custom: {String(value)}
        </span>
      ) : null}
    </div>
  );
}

const APP_PASSWORD_COPY: Record<Exclude<Provider, 'custom'>, string> = {
  gmail:
    'Gmail requires an App Password (not your account password) when using SMTP. Go to Google Account → Security → 2-Step Verification → App passwords. Use the generated 16-character password as your SMTP password.',
  outlook:
    'Outlook requires an App Password if you have 2FA enabled. Go to Microsoft Account → Security → Advanced security → App passwords.',
  yahoo:
    'Yahoo requires an App Password. Go to Yahoo Account Security → Generate app password.',
  zoho:
    'Zoho accepts your account password if 2FA is off. If 2FA is on, generate an Application-Specific Password under Zoho Account → Security → App Passwords.',
};

export function ProviderAppPasswordNote({ provider }: { provider: Provider }) {
  if (provider === 'custom') return null;
  return (
    <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-900">
      <strong>App Password required.</strong> {APP_PASSWORD_COPY[provider]}
    </p>
  );
}

interface ZohoRegionChipsProps {
  /** Current SMTP host — used to highlight the matching region chip. */
  currentSmtpHost: string;
  /** Called with the region's full SMTP+IMAP config when a chip is clicked. */
  onPick: (config: ProviderConfig) => void;
}

/**
 * Data-center picker shown only when the Zoho provider is active. Zoho's
 * SMTP/IMAP hostnames differ per region (see `ZOHO_REGIONS`); the Zoho
 * quick-fill chip defaults to US/Global, and this row lets the user switch
 * to their actual DC in one click.
 */
export function ZohoRegionChips({ currentSmtpHost, onPick }: ZohoRegionChipsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-stone-600">Zoho region:</span>
      {ZOHO_REGIONS.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onPick(r.config)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            currentSmtpHost === r.config.smtpHost
              ? 'border-brand-500 bg-brand-50 text-brand-700'
              : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
          }`}
          data-testid={`zoho-region-${r.key}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Map a known SMTP/IMAP error code to a plain-English explanation
 * + fix hint. Returns `null` if the code is unknown — the caller
 * should fall back to the raw error message.
 */
export function errorHint(
  errCode: string | undefined | null,
  host?: string,
  port?: number,
): string | null {
  if (!errCode) return null;

  // Zoho-specific: a login that fails against a zoho host is most often IMAP
  // access being switched off (off by default), the wrong data center, or
  // 2FA needing an app-specific password — not a mistyped password.
  const isZohoHost = (host ?? '').includes('zoho');
  if (isZohoHost && (errCode === 'IMAP_EAUTH' || errCode === 'EAUTH')) {
    return (
      'Zoho login refused. Most likely: (1) IMAP is off — enable it at Zoho Mail → Settings → Mail Accounts → IMAP Access → Enable; ' +
      '(2) 2FA is on — generate an app-specific password at Zoho Account → Security → App Passwords and use that; ' +
      '(3) wrong data center — pick your Zoho region above so the host matches your mailbox.'
    );
  }

  switch (errCode) {
    case 'EAUTH':
      return 'Wrong username or password. Gmail / Yahoo / Outlook require an App Password, not your account password.';
    case 'ECONNREFUSED':
      return `Cannot reach ${host ?? 'the host'}:${port ?? '?'}. Check the SMTP host and port — try 587 instead of 465 or vice versa.`;
    case 'ETIMEDOUT':
      return `Connection timed out. Your SMTP host may be blocking port ${port ?? '?'} — try a different port.`;
    case 'ENOTFOUND':
      return `Hostname ${host ?? 'unknown'} not found. Check for typos in the SMTP host.`;
    case 'IMAP_EAUTH':
      return 'IMAP login failed. If SMTP passed, your IMAP password may be different from your SMTP password.';
    default:
      return null;
  }
}