import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { getInboxes } from '@/app/(dashboard)/_lib/data';
import { InboxListTable } from '@/app/(dashboard)/_components/InboxListTable';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const inboxes = await getInboxes();

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Inboxes</h1>
          <p className="text-sm text-slate-600">
            All inboxes connected to your account. Tick rows to pause or resume warmup in bulk.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/inboxes/connect"
            className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Connect inbox
          </Link>
        </div>
      </header>

      <InboxListTable inboxes={inboxes} />
    </div>
  );
}