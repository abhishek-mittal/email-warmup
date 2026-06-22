import { redirect } from 'next/navigation';
import { currentUserId } from '@/lib/api-server';
import { getPoolInboxes } from '@/app/(dashboard)/_lib/data';
import { BatchUploadCsv } from '@/app/(dashboard)/_components/BatchUploadCsv';
import { BatchUploadWizard } from '@/app/(dashboard)/_components/BatchUploadWizard';
import { PoolInboxGrid } from '@/app/(dashboard)/pool/_components/PoolInboxGrid';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const poolInboxes = await getPoolInboxes();

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Warming Pool</h1>
          <p className="text-sm text-slate-600">
            Inboxes dedicated to peer-to-peer warmup traffic for your account.
          </p>
        </div>
        <div className="flex gap-2">
          <BatchUploadCsv endpoint="/pool-inboxes/batch/csv" />
          <BatchUploadWizard endpoint="/pool-inboxes/batch" />
        </div>
      </header>

      {poolInboxes.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <p className="text-sm text-slate-600">
            No pool inboxes yet. Add pool inboxes to enable warming.
          </p>
          <BatchUploadWizard endpoint="/pool-inboxes/batch" label="Add pool inboxes" />
        </div>
      ) : (
        <PoolInboxGrid poolInboxes={poolInboxes} />
      )}
    </div>
  );
}
