import Link from 'next/link';
import { hasFeature } from '@/lib/plan-config';
import type { Plan } from '@/lib/types';

interface Props {
  userPlan: Plan;
  minPlan: Plan;
  feature: string;
  description?: string;
  children: React.ReactNode;
}

export function PlanGate({ userPlan, minPlan, feature, description, children }: Props) {
  if (hasFeature(userPlan, minPlan)) {
    return <>{children}</>;
  }

  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-200 text-stone-600">
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
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div className="flex-1 space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-stone-900">{feature}</h3>
            <p className="mt-0.5 text-xs text-stone-600">
              {description ?? `Available on the ${minPlan} plan and above.`}
            </p>
          </div>
          <Link
            href="/billing"
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700"
          >
            Upgrade required
          </Link>
        </div>
      </div>
    </div>
  );
}
