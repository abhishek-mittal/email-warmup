import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { getInboxes, getInboxSummaries } from '@/app/(dashboard)/_lib/data';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const [inboxes, summaries] = await Promise.all([
    getInboxes(),
    getInboxSummaries(),
  ]);

  return (
    <div className="space-y-8">
      <header>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-600">
            {summaries.total} {summaries.total === 1 ? 'inbox' : 'inboxes'} connected · avg score {summaries.avgScore ?? '—'}
          </p>
        </header>

        {inboxes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <h2 className="text-lg font-semibold text-slate-900">No inboxes yet</h2>
            <p className="mt-1 text-sm text-slate-600">Connect your first inbox to start warming.</p>
            <Link
              href="/inboxes/connect"
              className="mt-4 inline-block rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Connect your first inbox
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Score</th>
                  <th className="px-4 py-3">Warmup day</th>
                  <th className="px-4 py-3">Trend</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inboxes.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{i.email}</td>
                    <td className="px-4 py-3 text-slate-600 capitalize">{i.provider}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {i.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {i.score != null ? i.score : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{i.warmupDay ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{i.trend ?? '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <Link className="text-indigo-600 hover:underline" href={`/inboxes/${i.id}`}>
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}