import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { getPoolInbox } from '@/app/(dashboard)/_lib/data';
import { ReadinessBadge } from '@/app/(dashboard)/pool/_components/ReadinessBadge';
import { ConnectionSummaryStrip } from '@/app/(dashboard)/pool/_components/ConnectionSummaryStrip';
import { ReanalyzeButton } from '@/app/(dashboard)/pool/_components/ReanalyzeButton';
import { formatDate } from '@/lib/format';
import { LiveStatusPanel } from './_components/LiveStatusPanel';
import { PoolDetailTabs } from './_components/PoolDetailTabs';

export const dynamic = 'force-dynamic';

/**
 * Pool inbox detail page — full-page replacement for the old
 * `PoolInboxDetailPanel` drawer. Mirrors `/inboxes/[id]/page.tsx`'s
 * structure: server component fetches the row once, client components
 * below handle their own data (Live Status polls every 3s, each tab
 * fetches on demand).
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');
  const { id } = await params;

  const poolInbox = await getPoolInbox(id);
  if (!poolInbox) notFound();

  return (
    <div className="space-y-6">
      <Link href="/pool" className="text-sm text-brand-600 hover:underline">
        &larr; Back to Warming Pool
      </Link>

      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-stone-900">{poolInbox.email}</h1>
            <ReadinessBadge status={poolInbox.status} analysis={poolInbox.analysis} />
          </div>
          <p className="mt-1 text-sm capitalize text-stone-600">
            {poolInbox.provider} &middot; added {formatDate(poolInbox.createdAt)}
          </p>
        </div>
        <ReanalyzeButton poolInboxId={poolInbox.id} />
      </header>

      <ConnectionSummaryStrip poolInboxId={poolInbox.id} />

      <LiveStatusPanel poolInboxId={poolInbox.id} />

      <PoolDetailTabs poolInbox={poolInbox} />
    </div>
  );
}
