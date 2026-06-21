import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { serverApi } from '@/lib/api-server';
import { CheckoutButton, PortalButton } from './_components/BillingActions';
import { PLANS } from '@/lib/plan-config';
import { daysRemaining } from '@/lib/format';
import type { BillingStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const status = await serverApi<BillingStatus>('/billing/status').catch(
    () => ({ plan: 'trial' as const, trialEndsAt: null, inboxesUsed: 0, inboxLimit: 0, billingPortalUrl: null }),
  );

  const remaining = daysRemaining(status.trialEndsAt);
  const showTrial = status.plan === 'trial' && remaining != null && remaining > 0;
  const inboxLimit = status.inboxLimit;
  const inboxPct = inboxLimit > 0 ? Math.min(100, (status.inboxesUsed / inboxLimit) * 100) : 0;
  const isPaidPlan = ['starter', 'growth', 'agency', 'enterprise'].includes(status.plan);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Billing</h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your plan, track usage, and upgrade when you outgrow your limits.
        </p>
      </div>

      {showTrial ? (
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
          <span className="font-semibold">Trial ends in {remaining} day{remaining === 1 ? '' : 's'}.</span>{' '}
          Upgrade now to keep your warmup pool running.
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Current plan</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {status.plan === 'free'
                ? 'No plan — connect an inbox to start a trial.'
                : status.plan === 'trial'
                ? 'You are on a 7-day free trial.'
                : `You are on the ${status.plan} plan.`}
            </p>
            <p className="mt-3 text-3xl font-semibold capitalize text-slate-900">{status.plan}</p>
          </div>
          <div className="flex items-center gap-2">
            {isPaidPlan ? <PortalButton /> : null}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UsageBar
            label="Inboxes"
            used={status.inboxesUsed}
            limit={inboxLimit}
            pct={inboxPct}
          />
          <UsageBar
            label="Placement tests"
            used={0}
            limit={
              status.plan === 'trial' || status.plan === 'starter'
                ? 1
                : status.plan === 'growth'
                ? 5
                : 999
            }
            pct={0}
            note="This month, per inbox"
          />
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-900">Plans</h2>
        <p className="mt-0.5 text-xs text-slate-500">Choose a plan that fits your team.</p>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((plan) => {
            const isCurrent = plan.id === status.plan;
            return (
              <div
                key={plan.id}
                className={`flex flex-col rounded-2xl border bg-white p-5 shadow-sm ${
                  plan.highlighted ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">{plan.name}</h3>
                  {plan.highlighted ? (
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                      Popular
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{plan.priceLabel}</p>
                <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-700">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  {isCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="w-full cursor-not-allowed rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-500"
                    >
                      Current plan
                    </button>
                  ) : (
                    <CheckoutButton plan={plan.id} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UsageBar({
  label,
  used,
  limit,
  pct,
  note,
}: {
  label: string;
  used: number;
  limit: number;
  pct: number;
  note?: string;
}) {
  const isUnlimited = limit < 0 || limit > 900;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="font-mono text-slate-600">
          {used} / {isUnlimited ? '∞' : limit}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-all ${
            pct >= 90 ? 'bg-rose-500' : 'bg-indigo-500'
          }`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {note ? <p className="mt-1.5 text-[10px] text-slate-500">{note}</p> : null}
    </div>
  );
}
