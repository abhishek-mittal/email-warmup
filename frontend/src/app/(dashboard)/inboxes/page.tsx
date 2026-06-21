import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { DashboardShell } from '@/components/DashboardShell';
import { getInboxes } from '@/app/(dashboard)/_lib/data';
import { InboxActions } from '@/app/(dashboard)/inboxes/_components/InboxActions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const inboxes = await getInboxes();

  return (
    <DashboardShell>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Inboxes</h1>
            <p className="text-sm text-slate-600">All inboxes connected to your account.</p>
          </div>
          <Link
            href="/inboxes/connect"
            className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Connect inbox
          </Link>
        </header>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3">Speed</th>
                <th className="px-4 py-3">Day</th>
                <th className="px-4 py-3">Last placement</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {inboxes.map((i) => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{i.email}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 capitalize">
                      {i.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{i.score != null ? i.score : '—'}</td>
                  <td className="px-4 py-3 text-slate-600 capitalize">{i.warmupSpeed ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{i.warmupDay ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{i.lastPlacementAt ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <InboxActions inboxId={i.id} status={i.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardShell>
  );
}