'use client';

import { useEffect, useId, useState } from 'react';

/**
 * A self-contained "Setup guide" button + modal for the Connect Inbox page.
 *
 * Connecting a mailbox for warmup has provider-specific prerequisites that
 * are easy to miss — Gmail/Outlook use one-click OAuth, but custom SMTP
 * providers (Zoho, Yahoo, …) need IMAP switched on and, with 2FA, an
 * app-specific password. This modal lays out the exact steps per provider
 * with deep links to the right settings pages, so the user doesn't have to
 * hunt for them or hit a precheck failure first.
 *
 * Content only — it does not touch the form state. The matching inline hints
 * (ProviderAppPasswordNote, ZohoRegionChips, errorHint) still live on the
 * form itself.
 */

type GuideKey = 'gmail' | 'outlook' | 'zoho' | 'yahoo' | 'other';

interface GuideStep {
  text: string;
  /** Optional external link rendered as an action under the step. */
  link?: { href: string; label: string };
}

interface Guide {
  key: GuideKey;
  label: string;
  /** One-line summary of the connect method. */
  summary: string;
  steps: GuideStep[];
  /** Shown as an amber "watch out" callout under the steps. */
  gotcha?: string;
}

const GUIDES: Guide[] = [
  {
    key: 'gmail',
    label: 'Gmail',
    summary: 'One-click OAuth — no password or app password needed.',
    steps: [
      { text: 'On the Gmail tab, click “Connect with Google”.' },
      { text: 'Sign in and grant send + read access when Google asks.' },
      { text: 'You’re returned here connected. The 5-step pre-check runs automatically.' },
      {
        text: 'If the pre-check fails, make sure IMAP is enabled in Gmail settings, then reconnect.',
        link: {
          href: 'https://mail.google.com/mail/u/0/#settings/fwdandpop',
          label: 'Gmail IMAP settings',
        },
      },
    ],
    gotcha:
      'Google Workspace accounts may need an admin to allow IMAP and third-party access for the whole domain.',
  },
  {
    key: 'outlook',
    label: 'Outlook',
    summary: 'One-click OAuth via Microsoft — no password or app password needed.',
    steps: [
      { text: 'On the Outlook tab, click “Connect with Microsoft”.' },
      { text: 'Sign in and grant Mail send + read access.' },
      { text: 'You’re returned here connected and the pre-check runs automatically.' },
      {
        text: 'Check your account’s security settings if sign-in is blocked.',
        link: {
          href: 'https://account.microsoft.com/security',
          label: 'Microsoft security settings',
        },
      },
    ],
    gotcha:
      'Some Microsoft 365 organizations disable IMAP by default — an admin may need to enable it before warmup can receive mail.',
  },
  {
    key: 'zoho',
    label: 'Zoho',
    summary: 'Custom SMTP/IMAP. Enable IMAP first, and use an app password if 2FA is on.',
    steps: [
      {
        text: 'Enable IMAP: Zoho Mail → Settings → Mail Accounts → IMAP Access → Enable. (Off by default — warmup needs it to receive and reply.)',
        link: { href: 'https://mail.zoho.com/zm/#settings/mailaccounts', label: 'Zoho IMAP access' },
      },
      {
        text: 'If 2FA is on, generate an app-specific password and use it instead of your account password.',
        link: {
          href: 'https://accounts.zoho.com/home#security/app_password',
          label: 'Zoho app passwords',
        },
      },
      {
        text: 'Open the Custom SMTP tab, click the Zoho chip, then pick your Zoho region (US / EU / IN / AU / …) so the host matches your data center.',
      },
      {
        text: 'Enter your email + password, tick “Also configure IMAP” and “Join the shared warmup pool”, then Connect.',
      },
    ],
    gotcha:
      'Picking the wrong region is the #1 Zoho “wrong password” false alarm — a EU mailbox will reject the US host (smtp.zoho.com).',
  },
  {
    key: 'yahoo',
    label: 'Yahoo',
    summary: 'Custom SMTP/IMAP. Yahoo always requires an app password.',
    steps: [
      {
        text: 'Generate an app password: Yahoo Account Security → Generate app password.',
        link: {
          href: 'https://login.yahoo.com/account/security/app-passwords',
          label: 'Yahoo app passwords',
        },
      },
      { text: 'Open the Custom SMTP tab and click the Yahoo chip to fill the hosts + ports.' },
      {
        text: 'Enter your email + the app password, tick “Also configure IMAP” and “Join the shared warmup pool”, then Connect.',
      },
    ],
    gotcha: 'Your normal Yahoo password will not work for SMTP/IMAP — only the app password does.',
  },
  {
    key: 'other',
    label: 'Other SMTP',
    summary: 'Any provider with SMTP + IMAP access.',
    steps: [
      { text: 'Find your provider’s SMTP and IMAP host + port (usually in their help docs or mail settings).' },
      { text: 'Enable IMAP in your provider’s settings if it isn’t on by default.' },
      { text: 'If the provider enforces 2FA, create an app-specific password for it.' },
      {
        text: 'Open the Custom SMTP tab, enter the hosts/ports and credentials, tick “Also configure IMAP” and “Join the shared warmup pool”, then Connect. Common ports: SMTP 587 (STARTTLS) or 465 (SSL), IMAP 993 (SSL).',
      },
    ],
  },
];

export function ConnectSetupGuide() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<GuideKey>('gmail');
  const titleId = useId();

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const guide = GUIDES.find((g) => g.key === active) ?? GUIDES[0];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
      >
        <HelpIcon /> Setup guide
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-stone-900/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
              <h2 id={titleId} className="text-lg font-semibold text-stone-900">
                How to connect your inbox
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-full p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
              >
                ✕
              </button>
            </div>

            {/* Provider selector */}
            <div className="flex flex-wrap gap-2 border-b border-stone-200 px-6 py-3">
              {GUIDES.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setActive(g.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active === g.key
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>

            {/* Steps */}
            <div className="overflow-y-auto px-6 py-5">
              <p className="mb-4 text-sm text-stone-600">{guide.summary}</p>
              <ol className="space-y-4">
                {guide.steps.map((step, idx) => (
                  <li key={idx} className="flex gap-3">
                    <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                      {idx + 1}
                    </span>
                    <div className="space-y-1.5">
                      <p className="text-sm leading-relaxed text-stone-800">{step.text}</p>
                      {step.link ? (
                        <a
                          href={step.link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                        >
                          {step.link.label} <ExternalLinkIcon />
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>

              {guide.gotcha ? (
                <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                  <strong>Heads up.</strong> {guide.gotcha}
                </div>
              ) : null}
            </div>

            <div className="flex justify-end border-t border-stone-200 px-6 py-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function HelpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7.8 7.6a2.2 2.2 0 1 1 3.2 2c-.8.5-1 .9-1 1.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="10" cy="14.2" r="0.9" fill="currentColor" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M7 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2M12 4h4m0 0v4m0-4L9 11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
