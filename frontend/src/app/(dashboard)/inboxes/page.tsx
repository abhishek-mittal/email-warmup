import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { serverApi } from '@/lib/api-server';
import { InboxStatusBadge } from '@/components/InboxStatusBadge';
import { InboxActions } from './_components/InboxActions';
import { scoreColor, providerIcon, trendArrow } from '@/lib/plan-config';
import { warmupDayLabel } from '@/lib/format';
import { getInboxScores, getInboxIssues, getLatestPlacementTest } from '../_lib/data';
import type { Inbox } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function InboxesPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const inboxes = await serverApi<Inbox[]>('/inboxes').catch(() => [] as Inbox[]);

  const enriched = await Promise.all(
    inboxes.map(async (inbox) => {
      const [score, issues, placement] = await Promise.all([
        getInboxScores(inbox.id),
        getInboxIssues(inbox.id),
        getLatestPlacementTest(inbox.id),
      ]);
      return { inbox, score, issues, placement };
    }),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Inboxes</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage every connected inbox, run placement tests, and pause / resume warmup.
          </p>
        </div>
        <Link
          href="/inboxes/connect"
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          Connect inbox
        </Link>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {enriched.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <h2 className="text-base font-semibold text-slate-900">No inboxes yet</h2>
            <p className="mt-1 text-sm text-slate-600">Connect Gmail, Outlook, or a custom SMTP server.</p>
            <Link
              href="/inboxes/connect"
              className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
            >
              Connect inbox
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3">Inbox</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Score</th>
                  <th className="px-5 py-3">Warmup</th>
                  <th className="px-5 py-3">Last placement</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {enriched.map(({ inbox, score, placement }) => {
                  const colors = score?.current != null ? scoreColor(score.current) : null;
                  const trendInfo = score ? trendArrow(score.trend) : trendArrow('stable');
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
                        {score?.current == null ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold ${colors?.bg} ${colors?.text}`}
                            >
                              {Math.round(score.current)}
                            </span>
                            <span className={`text-xs ${trendInfo.color}`}>{trendInfo.symbol}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-slate-600">
                        {warmupDayLabel(inbox.warmupDay, inbox.warmupSpeed)}
                      </td>
                      <td className="px-5 py-3.5 text-slate-600">
                        {placement
                          ? placement.status === 'complete'
                            ? `${placement.primary}% Primary`
                            : 'Running…'
                          : 'Never'}
                      </td>
                      <td className="px-5 py-3.5">
                        <InboxActions
                          inboxId={inbox.id}
                          status={inbox.status}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
