'use client';

import { DnsStatusCard } from '@/components/DnsStatusCard';
import { HealthScoreGauge } from './HealthScoreGauge';
import { PulseDot, type PulseState } from '@/components/PulseDot';
import { formatDate } from '@/lib/format';
import {
  poolInboxReadiness,
  poolInboxReadinessStyle,
  type PoolInboxReadiness,
} from '@/lib/plan-config';
import type { PoolInbox } from '@/lib/types';

interface Props {
  poolInbox: PoolInbox;
  onClose: () => void;
  /** PulseDot state next to the heading — wired by the page so the
   *  panel reflects any background polling happening for this inbox. */
  pollState?: PulseState;
}

/**
 * Plain-language copy for each DNS check, plus the "how to fix" hint
 * surfaced in the bottom-of-panel action card. Kept in one place so
 * a copy change is one edit, not five.
 */
const DNS_HOW_TO_FIX: Record<'spf' | 'dkim' | 'dmarc' | 'mx' | 'rdns', string> = {
  spf: "Add an SPF TXT record at your domain's DNS host. Start with `v=spf1 include:_spf.google.com ~all` (substitute your email provider) and gradually widen to your sending IPs.",
  dkim: "Generate a DKIM key pair in your email provider (Google Workspace / Microsoft 365 / SendGrid all do this) and publish the public key as a TXT record at `<selector>._domainkey.yourdomain.com`.",
  dmarc: "Add a DMARC TXT record at `_dmarc.yourdomain.com`. Start with `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` so you can monitor without rejecting mail yet.",
  mx: 'Make sure your domain has at least one MX record pointing to a working mail server. If you only send (no receive) you can use a placeholder like `mx.yourdomain.com` with priority 10.',
  rdns: 'Contact your server / VPS provider and ask them to set a PTR record for your sending IP that resolves back to a domain you control. rDNS is rarely blocking but improves inbox placement.',
};

/**
 * Minimum-impact order: fix the highest-leverage missing record first.
 * SPF and DKIM are the two that most affect deliverability; DMARC is
 * policy that aligns them; MX is required for the receiving side;
 * rDNS is the least impactful.
 */
const FIX_PRIORITY: Array<'dkim' | 'spf' | 'dmarc' | 'mx' | 'rdns'> = [
  'dkim',
  'spf',
  'dmarc',
  'mx',
  'rdns',
];

const READINESS_SUMMARY: Record<PoolInboxReadiness, { headline: string; body: string }> = {
  eligible: {
    headline: 'This inbox is ready to warm with.',
    body: 'All critical DNS records are in place. Warmup emails sent from this inbox should land in the Primary tab of the receiving Gmail / Outlook / Yahoo inboxes.',
  },
  'not-eligible': {
    headline: "This inbox isn't safe to warm with yet.",
    body: 'One or more critical DNS records are missing. Warmup emails will likely land in Spam or be rejected outright by the receiving inbox. See the fix below.',
  },
  analyzing: {
    headline: 'DNS analysis is running.',
    body: 'We just started checking this inbox — SPF, DKIM, DMARC, MX and rDNS. This usually takes a few seconds. The badge at the top will switch to "Ready" or "Needs attention" when it finishes.',
  },
  error: {
    headline: 'The analysis job failed.',
    body: 'Most commonly a DNS timeout. Click "Re-analyze" below to retry, or check the error message in the active-pairs panel.',
  },
};

export function PoolInboxDetailPanel({ poolInbox, onClose, pollState = 'idle' }: Props) {
  const analysis = poolInbox.analysis;
  const readiness = poolInboxReadiness(poolInbox.status, analysis);
  const readinessStyle = poolInboxReadinessStyle(readiness);
  const summary = READINESS_SUMMARY[readiness];

  // Determine which DNS checks are failing so we can present a single,
  // prioritized "fix this first" recommendation.
  const failing: Array<'spf' | 'dkim' | 'dmarc' | 'mx' | 'rdns'> = [];
  if (analysis) {
    if (analysis.spfValid === false) failing.push('spf');
    if (analysis.dkimValid === false) failing.push('dkim');
    if (analysis.dmarcValid === false) failing.push('dmarc');
    if (analysis.mxValid === false) failing.push('mx');
    if (analysis.rdnsValid === false) failing.push('rdns');
  }
  const topFix = FIX_PRIORITY.find((k) => failing.includes(k));

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div className="relative h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">{poolInbox.email}</h2>
              <PulseDot state={pollState} label={`Status: ${readinessStyle.label}`} />
            </div>
            <p className="text-sm capitalize text-slate-600">
              {poolInbox.provider} · added {formatDate(poolInbox.createdAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <section
          className={`mt-4 rounded-2xl border p-4 ${readinessStyle.bg} ${readinessStyle.text.replace('text-', 'border-')}`}
        >
          <p className="text-sm font-semibold">{readinessStyle.label}</p>
          <p className="mt-1 text-sm font-medium">{summary.headline}</p>
          <p className="mt-1 text-xs leading-relaxed opacity-90">{summary.body}</p>
        </section>

        <div className="mt-6 flex justify-center">
          <HealthScoreGauge score={analysis?.healthScore ?? null} />
        </div>

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-slate-900">DNS records</h3>
          <p className="mt-1 text-xs text-slate-500">
            These are the records Gmail / Outlook / Yahoo check when deciding
            whether to deliver an email or file it as Spam.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <DnsStatusCard type="spf" status={analysis?.spfValid ?? null} />
            <DnsStatusCard type="dkim" status={analysis?.dkimValid ?? null} />
            <DnsStatusCard type="dmarc" status={analysis?.dmarcValid ?? null} />
            <DnsStatusCard type="mx" status={analysis?.mxValid ?? null} />
            <DnsStatusCard type="rdns" status={analysis?.rdnsValid ?? null} />
          </div>
        </section>

        {failing.length > 0 && topFix ? (
          <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Fix this first: {topFix.toUpperCase()}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-amber-800">
              {DNS_HOW_TO_FIX[topFix]}
            </p>
            {failing.length > 1 ? (
              <p className="mt-2 text-xs text-amber-700">
                {failing.length - 1} other {failing.length - 1 === 1 ? 'record is' : 'records are'} also failing — fix this one first, then re-analyze to see the next most-impactful gap.
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="mt-6 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Active pairs
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{poolInbox.activePairs}</p>
            <p className="mt-1 text-[10px] leading-snug text-slate-500">
              How many other inboxes this one is currently paired with for warmup traffic.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Date added
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900">
              {formatDate(poolInbox.createdAt)}
            </p>
            <p className="mt-1 text-[10px] leading-snug text-slate-500">
              {poolInbox.lastUsedAt
                ? `Last used ${formatDate(poolInbox.lastUsedAt)}`
                : 'Never used yet.'}
            </p>
          </div>
        </section>

        {!analysis ? (
          <p className="mt-6 text-sm text-slate-500">
            {poolInbox.status === 'pending'
              ? 'Analysing… DNS health will appear here once the analysis job finishes.'
              : 'No analysis available yet. Click "Re-analyze" on the row to retry.'}
          </p>
        ) : null}
      </div>
    </div>
  );
}
