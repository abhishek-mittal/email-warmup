'use client';

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import type { PoolConnectionSummary } from '@/lib/pool-activity-types';

/**
 * Read-only summary of the SMTP / IMAP (or OAuth) settings a pool inbox
 * was configured with. Sits between the panel header and the tabs so the
 * user can verify at a glance what credentials are in use.
 *
 * Per the T028 spec, we never display passwords / tokens / secrets —
 * only their presence (✓ / ✗). SMTP/IMAP host:port are not secrets
 * and are always shown in full.
 */
export function ConnectionSummaryStrip({ poolInboxId }: { poolInboxId: string }) {
  const api = useApi();
  const [summary, setSummary] = useState<PoolConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<PoolConnectionSummary>(`/pool-inboxes/${poolInboxId}/connection-summary`)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load connection summary');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, poolInboxId]);

  if (loading) {
    return (
      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs text-stone-500">
        Loading connection details…
      </div>
    );
  }
  if (error || !summary) {
    return (
      <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
        {error ?? 'Could not load connection details.'}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2" data-testid="pool-connection-summary">
      {summary.provider === 'gmail' || summary.provider === 'outlook' ? (
        <OAuthSummary summary={summary} />
      ) : (
        <CustomSummary summary={summary} />
      )}
      {!summary.imapConfigured ? (
        <p className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800">
          <span aria-hidden>⚠</span>
          IMAP missing — receive actions (open / star / reply / rescue) are disabled for this inbox.
        </p>
      ) : null}
    </div>
  );
}

function OAuthSummary({ summary }: { summary: PoolConnectionSummary }) {
  return (
    <div className="grid grid-cols-1 gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs sm:grid-cols-3">
      <Field
        label="Provider"
        value={
          summary.provider === 'gmail' ? 'Gmail OAuth' : 'Outlook OAuth'
        }
      />
      <Field
        label="OAuth App"
        value={
          summary.oauthClientIdPrefix
            ? `client_id: ${summary.oauthClientIdPrefix}`
            : '—'
        }
      />
      <Field
        label="Token"
        value={
          summary.refreshTokenPresent ? '✓ Refresh token present' : '✗ Missing'
        }
      />
    </div>
  );
}

function CustomSummary({ summary }: { summary: PoolConnectionSummary }) {
  return (
    <div className="grid grid-cols-1 gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs sm:grid-cols-2">
      <Field
        label="SMTP"
        value={
          summary.smtpHost && summary.smtpPort
            ? `${summary.smtpHost} : ${summary.smtpPort}   ${
                summary.smtpPort === 465
                  ? 'SSL'
                  : summary.smtpPort === 587
                    ? 'TLS'
                    : summary.smtpPort === 25
                      ? 'plain'
                      : ''
              }`.trim()
            : '—'
        }
        extra={
          summary.smtpUser
            ? `User ${summary.smtpUser}`
            : undefined
        }
        secretPresent={summary.smtpPasswordPresent}
      />
      <Field
        label="IMAP"
        value={
          summary.imapHost && summary.imapPort
            ? `${summary.imapHost} : ${summary.imapPort}   ${
                summary.imapPort === 993 ? 'SSL' : ''
              }`.trim()
            : 'not configured'
        }
        extra={summary.imapUser ? `User ${summary.imapUser}` : undefined}
        secretPresent={summary.imapPasswordPresent}
      />
    </div>
  );
}

function Field({
  label,
  value,
  extra,
  secretPresent,
}: {
  label: string;
  value: string;
  extra?: string;
  secretPresent?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-stone-500">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-[11px] text-stone-800">{value}</p>
      {extra ? (
        <p className="mt-0.5 text-[10px] text-stone-500">{extra}</p>
      ) : null}
      {secretPresent !== undefined ? (
        <p className="mt-0.5 text-[10px] text-stone-500">
          {secretPresent ? '✓ Password present' : '✗ Missing'}
        </p>
      ) : null}
    </div>
  );
}