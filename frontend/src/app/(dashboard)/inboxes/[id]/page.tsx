import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { serverApi } from '@/lib/api-server';
import { ReputationGauge } from '@/components/ReputationGauge';
import { ScoreHistoryChart } from '@/components/ScoreHistoryChart';
import { DnsStatusCard } from '@/components/DnsStatusCard';
import { PlacementBar } from '@/components/PlacementBar';
import { InboxStatusBadge } from '@/components/InboxStatusBadge';
import { RunPlacementButton } from './_components/RunPlacementButton';
import {
  getInboxScores,
  getInboxIssues,
  getLatestPlacementTest,
  getLatestDnsCheck,
  getLatestBlacklistCheck,
} from '../../_lib/data';
import type { Inbox, BillingStatus, Plan } from '@/lib/types';

const SPEED_DAYS: Record<string, number> = {
  slow: 45,
  medium: 30,
  fast: 14,
};

export const dynamic = 'force-dynamic';

export default async function InboxDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const { id } = await params;

  let inbox: Inbox | null = null;
  try {
    const inboxes = await serverApi<Inbox[]>('/inboxes');
    inbox = inboxes.find((i) => i.id === id) ?? null;
  } catch {
    inbox = null;
  }
  if (!inbox) notFound();

  const [score, issues, placement, dns, blacklist, billing] = await Promise.all([
    getInboxScores(id),
    getInboxIssues(id),
    getLatestPlacementTest(id),
    getLatestDnsCheck(id),
    getLatestBlacklistCheck(id),
    serverApi<BillingStatus>('/billing/status').catch(
      () => ({ plan: 'trial' as Plan, trialEndsAt: null, inboxesUsed: 0, inboxLimit: 0, billingPortalUrl: null }),
    ),
  ]);

  const totalDays = SPEED_DAYS[inbox.warmupSpeed ?? 'medium'] ?? 30;
  const progressPct = Math.min(
    100,
    Math.round(((inbox.warmupDay ?? 0) / totalDays) * 100),
  );
  const plan = billing.plan;
  const breakdown = score?.breakdown ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/inboxes"
            className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            ← All inboxes
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            {inbox.email}
          </h1>
          <div className="mt-1 flex items-center gap-2">
            <InboxStatusBadge status={inbox.status} />
            <span className="text-xs text-slate-500 capitalize">{inbox.provider}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/inboxes/${id}/diagnostics`}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Diagnostics
          </Link>
          <RunPlacementButton
            inboxId={id}
            disabled={false}
            disabledReason={undefined}
          />
        </div>
      </div>

      {issues.length > 0 ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <div className="font-semibold">{issues.length} issue{issues.length === 1 ? '' : 's'} detected.</div>
          <Link
            href={`/inboxes/${id}/diagnostics`}
            className="ml-auto text-xs font-medium text-rose-700 hover:text-rose-900"
          >
            View diagnostics →
          </Link>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <ReputationGauge
            score={score?.current ?? null}
            trend={score?.trend ?? 'stable'}
            breakdown={breakdown}
            plan={plan}
          />
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Score history (last 30 days)</h2>
            <p className="mt-1 text-xs text-slate-500">
              Updated daily at 06:00 UTC by the score-compute job.
            </p>
            <div className="mt-4">
              <ScoreHistoryChart history={score?.history ?? []} />
            </div>
          </div>
        </div>
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Warmup progress</h2>
            <p className="mt-1 text-xs text-slate-500">
              Day {inbox.warmupDay ?? 0} of {totalDays} ({inbox.warmupSpeed ?? 'medium'} ramp)
            </p>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="mt-3 text-xs text-slate-600">
              Send volume increases daily up to the per-day cap of 200. After graduation, you can
              ramp into your real audience safely.
            </p>
          </div>
        </div>
      </div>

      <section>
        <h2 className="text-sm font-semibold text-slate-900">DNS records</h2>
        <p className="mt-1 text-xs text-slate-500">
          Last check: {dns?.checkedAt ? new Date(dns.checkedAt).toLocaleString() : 'Never'}.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <DnsStatusCard type="spf" status={dns?.spfValid ?? null} />
          <DnsStatusCard type="dkim" status={dns?.dkimValid ?? null} />
          <DnsStatusCard type="dmarc" status={dns?.dmarcValid ?? null} />
          <DnsStatusCard type="mx" status={dns?.mxValid ?? null} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-900">Blacklist status</h2>
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {blacklist?.listed ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-rose-500" aria-hidden />
                <span className="text-sm font-semibold text-rose-700">Listed on a blacklist</span>
              </div>
              <p className="text-xs text-slate-600">
                Listed zones: {blacklist.rblResults.map((r) => r.zone).join(', ')}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
              <span className="text-sm font-medium text-slate-700">Clean — not on any monitored RBL.</span>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Latest placement test</h2>
          {placement?.completedAt ? (
            <span className="text-xs text-slate-500">
              {new Date(placement.completedAt).toLocaleString()}
            </span>
          ) : null}
        </div>
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {placement && placement.status === 'complete' && placement.seedCount > 0 ? (
            <PlacementBar
              primary={placement.primary}
              promotions={placement.promotions}
              spam={placement.spam}
            />
          ) : placement?.status === 'pending' ? (
            <p className="text-sm text-slate-600">Test is running — refresh in a few minutes.</p>
          ) : (
            <p className="text-sm text-slate-600">
              No placement test yet. Click <span className="font-medium">Run Placement Test</span> to start.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
