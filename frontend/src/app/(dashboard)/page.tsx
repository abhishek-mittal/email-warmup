import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { serverApi, ApiError } from '@/lib/api-server';
import { InboxStatusBadge } from '@/components/InboxStatusBadge';
import { scoreColor, providerIcon, trendArrow } from '@/lib/plan-config';
import { warmupDayLabel } from '@/lib/format';
import type { Inbox } from '@/lib/types';
import { getInboxScores, getInboxIssues } from './_lib/data';

export const dynamic = 'force-dynamic';

export default async function DashboardOverview() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const inboxes = await serverApi<Inbox[]>('/inboxes').catch((e: ApiError) => {
    if (e.status === 401) redirect('/sign-in');
    return [] as Inbox[];
  });

  if (inboxes.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
          <PlusIcon />
        </div>
        <h1 className="mt-5 text-xl font-semibold text-slate-900">Connect your first inbox</h1>
        <p className="mt-2 text-sm text-slate-600">
          Warmup needs at least one inbox to start building reputation. Connect Gmail, Outlook, or
          any custom SMTP/IMAP server.
        </p>
        <Link
          href="/inboxes/connect"
          className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          Connect inbox
          <span aria-hidden>→</span>
        </Link>
      </div>
    );
  }

  // Per-inbox latest score
  const scores = await Promise.all(
    inboxes.map((i) => getInboxScores(i.id).catch(() => null)),
  );
  const issuesByInbox = await Promise.all(
    inboxes.map((i) => getInboxIssues(i.id).catch(() => [] as string[])),
  );

  const totalInboxes = inboxes.length;
  const inboxesWithIssues = issuesByInbox.filter((c) => c.length > 0).length;
  const scoreValues = scores
    .map((s) => s?.current ?? null)
    .filter((n): n is number => n != null);
  const avgScore =
    scoreValues.length > 0
      ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length)
      : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Overview</h1>
          <p className="mt-1 text-sm text-slate-600">
            Reputation health and warmup progress across every connected inbox.
          </p>
        </div>
        <Link
          href="/inboxes/connect"
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          <PlusIcon /> Connect inbox
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Total inboxes"
          value={String(totalInboxes)}
          sub={`${inboxes.filter((i) => i.status === 'active').length} warming up`}
        />
        <SummaryCard
          label="Average score"
          value={avgScore == null ? '—' : String(avgScore)}
          sub={avgScore == null ? 'No data yet' : 'Across all inboxes'}
          accent={avgScore != null ? scoreColor(avgScore).stroke : undefined}
        />
        <SummaryCard
          label="Inboxes with issues"
          value={String(inboxesWithIssues)}
          sub={inboxesWithIssues === 0 ? 'All clean' : 'Need attention'}
          accent={inboxesWithIssues > 0 ? '#e11d48' : undefined}
        />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-900">Inboxes</h2>
          <Link href="/inboxes" className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
            Manage all →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">Inbox</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Score</th>
                <th className="px-5 py-3">Warmup</th>
                <th className="px-5 py-3">Issues</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {inboxes.map((inbox, idx) => {
                const score = scores[idx]?.current ?? null;
                const trend = scores[idx]?.trend ?? 'stable';
                const issues = issuesByInbox[idx] ?? [];
                const colors = score != null ? scoreColor(score) : null;
                const trendInfo = trendArrow(trend);
                return (
                  <tr key={inbox.id} className="hover:bg-slate-50/50">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">
                          {providerIcon(inbox.provider)}
                        </span>
                        <div>
                          <div className="font-medium text-slate-900">{inbox.email}</div>
                          <div className="text-xs text-slate-500 capitalize">{inbox.provider}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <InboxStatusBadge status={inbox.status} />
                    </td>
                    <td className="px-5 py-3.5">
                      {score == null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold ${colors?.bg} ${colors?.text}`}
                          >
                            {Math.round(score)}
                          </span>
                          <span className={`text-xs ${trendInfo.color}`}>{trendInfo.symbol}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {warmupDayLabel(inbox.warmupDay, inbox.warmupSpeed)}
                    </td>
                    <td className="px-5 py-3.5">
                      {issues.length === 0 ? (
                        <span className="text-xs text-slate-400">None</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                          {issues.length} issue{issues.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        href={`/inboxes/${inbox.id}`}
                        className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
