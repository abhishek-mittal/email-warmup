'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { useToasts } from '@/components/Toast';

interface Props {
  inboxId: string;
  status: string;
  statusReason: string | null;
  poolConsentAt: string | null;
}

/** Why an inbox that isn't warming stopped, in words the owner can act on. */
const STOP_REASONS: Record<string, string> = {
  credentials_revoked:
    'Access to this mailbox was revoked or expired, so warmup has stopped. Reconnect it to continue — your warmup progress is kept.',
  transport_failed:
    'We could not sign in to this mailbox with the saved credentials, so it was not activated.',
  disconnected:
    'This inbox is disconnected. Warmup has stopped and its saved credentials were erased. Connect it again to resume.',
  blacklist: 'Warmup was paused automatically because this inbox appeared on a blocklist.',
  bounce_rate:
    'Warmup was paused automatically because more than 3% of this inbox’s warmup emails bounced in 24 hours. Our team needs to review it before it can be resumed.',
  released: 'The bounce hold on this inbox was reviewed and lifted. You can resume warmup.',
  plan: 'Warmup was paused because your plan no longer includes it.',
};

/**
 * Shared-pool participation for one inbox, plus the reason it stopped when
 * it did. Consent is recorded only when the owner switches it on here (or
 * ticks the box when connecting) and can be withdrawn at any time.
 */
export function PoolParticipation({ inboxId, status, statusReason, poolConsentAt }: Props) {
  const api = useApi();
  const router = useRouter();
  const { show } = useToasts();
  const [consented, setConsented] = useState(Boolean(poolConsentAt));
  const [busy, setBusy] = useState(false);

  async function setConsent(granted: boolean) {
    setBusy(true);
    try {
      await api(`/inboxes/${inboxId}/pool-consent`, {
        method: 'POST',
        body: JSON.stringify({ granted }),
      });
      setConsented(granted);
      show(
        granted
          ? 'This inbox now takes part in the shared warmup pool.'
          : 'This inbox has left the shared warmup pool.',
        'success',
      );
      router.refresh();
    } catch (e) {
      show(e instanceof ApiError ? e.body : 'Could not update pool participation', 'error');
    } finally {
      setBusy(false);
    }
  }

  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      await api(`/inboxes/${inboxId}/disconnect`, { method: 'POST', body: '{}' });
      show('Inbox disconnected. Its saved credentials were erased.', 'success');
      setConfirmingDisconnect(false);
      router.refresh();
    } catch (e) {
      show(e instanceof ApiError ? e.body : 'Could not disconnect this inbox', 'error');
    } finally {
      setBusy(false);
    }
  }

  const stopReason = statusReason ? STOP_REASONS[statusReason] : null;
  const needsReconnect =
    statusReason === 'credentials_revoked' ||
    statusReason === 'transport_failed' ||
    statusReason === 'disconnected';

  return (
    <div className="space-y-3">
      {stopReason && status !== 'active' ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{stopReason}</p>
          {needsReconnect ? (
            <Link
              href="/inboxes/connect"
              className="inline-flex shrink-0 items-center justify-center rounded-full bg-amber-600 px-4 py-2 font-medium text-white transition-colors hover:bg-amber-700"
            >
              Reconnect mailbox
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          <p className="font-medium text-slate-900">
            Shared warmup pool: {consented ? 'taking part' : 'not taking part'}
          </p>
          <p className="mt-1 text-slate-600">
            {consented
              ? 'This inbox exchanges automated warmup emails with other customers’ inboxes. Emails already delivered cannot be recalled if you leave.'
              : 'This inbox only warms against your own private pool. Join to exchange automated warmup emails with other customers’ inboxes.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConsent(!consented)}
          disabled={busy}
          aria-pressed={consented}
          className="inline-flex shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? 'Saving…' : consented ? 'Leave shared pool' : 'Join shared pool'}
        </button>
      </div>
      {status !== 'disconnected' ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-slate-900">Disconnect this inbox</p>
            <p className="mt-1 text-slate-600">
              Stops warmup for good and erases the credentials we hold for it. Its history stays,
              and it no longer counts toward your plan. Emails already delivered cannot be recalled.
            </p>
          </div>
          {confirmingDisconnect ? (
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className="rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(false)}
                disabled={busy}
                className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                Keep it
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDisconnect(true)}
              className="inline-flex shrink-0 items-center justify-center rounded-full border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
            >
              Disconnect
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
