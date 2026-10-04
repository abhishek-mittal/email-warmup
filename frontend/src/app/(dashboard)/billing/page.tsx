import { redirect } from 'next/navigation';
import { currentUserId, serverApi } from '@/lib/api-server';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const status = await serverApi<{
    plan: string;
    inboxesUsed: number;
    inboxLimit: number | 'unlimited';
    trialEndsAt: string | null;
  }>('/billing/status');

  return (
    <div className="space-y-6">
      <header>
          <h1 className="text-2xl font-semibold text-stone-900">Billing</h1>
          <p className="text-sm text-stone-600">Current plan: <strong className="capitalize">{status.plan}</strong></p>
        </header>

        <div className="rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-stone-700">Usage</h2>
          <p className="mt-2 text-sm text-stone-600">
            Inboxes: {status.inboxesUsed} /{' '}
            {status.inboxLimit === 'unlimited' ? 'Unlimited' : status.inboxLimit}
          </p>
          {status.trialEndsAt ? (
            <p className="mt-2 text-sm text-stone-600">
              Trial ends: {new Date(status.trialEndsAt).toLocaleDateString()}
            </p>
          ) : null}
        </div>
    </div>
  );
}