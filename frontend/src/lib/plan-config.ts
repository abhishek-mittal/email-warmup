import type { Plan } from './types';

export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  trial: 1,
  starter: 2,
  growth: 3,
  agency: 4,
  enterprise: 5,
};

export interface PlanInfo {
  id: Plan;
  name: string;
  priceLabel: string;
  inboxLimit: number | 'unlimited';
  placementTests: number | 'unlimited';
  features: string[];
  highlighted?: boolean;
}

export const PLANS: PlanInfo[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceLabel: '$29/mo',
    inboxLimit: 3,
    placementTests: 1,
    features: [
      'Up to 3 inboxes',
      '1 placement test / month',
      'Core DNS + blacklist monitoring',
      'Email alerts',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    priceLabel: '$99/mo',
    inboxLimit: 20,
    placementTests: 5,
    features: [
      'Up to 20 inboxes',
      '5 placement tests / month',
      'AI diagnostics with fix steps',
      'Slack alerts',
      'Full score breakdown',
    ],
    highlighted: true,
  },
  {
    id: 'agency',
    name: 'Agency',
    priceLabel: '$299/mo',
    inboxLimit: 100,
    placementTests: 'unlimited',
    features: [
      'Up to 100 inboxes',
      'Unlimited placement tests',
      'AI diagnostics with fix steps',
      'Slack alerts',
      'Full score breakdown',
      'Priority support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceLabel: 'Contact us',
    inboxLimit: 'unlimited',
    placementTests: 'unlimited',
    features: [
      'Unlimited inboxes',
      'Unlimited placement tests',
      'AI diagnostics with fix steps',
      'Slack alerts',
      'Full score breakdown',
      'Dedicated success manager',
    ],
  },
];

export function hasFeature(plan: Plan, minPlan: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}

export function scoreColor(score: number): {
  text: string;
  bg: string;
  stroke: string;
  label: string;
} {
  if (score >= 80) {
    return { text: 'text-emerald-700', bg: 'bg-emerald-100', stroke: '#059669', label: 'Excellent' };
  }
  if (score >= 60) {
    return { text: 'text-sky-700', bg: 'bg-sky-100', stroke: '#0284c7', label: 'Good' };
  }
  if (score >= 40) {
    return { text: 'text-amber-700', bg: 'bg-amber-100', stroke: '#d97706', label: 'Building' };
  }
  if (score >= 20) {
    return { text: 'text-orange-700', bg: 'bg-orange-100', stroke: '#ea580c', label: 'At risk' };
  }
  return { text: 'text-rose-700', bg: 'bg-rose-100', stroke: '#e11d48', label: 'Critical' };
}

export function inboxStatusColor(status: string): {
  bg: string;
  text: string;
  label: string;
} {
  switch (status) {
    case 'active':
      return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Warming Up' };
    case 'paused':
      return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Paused' };
    case 'pending':
      return { bg: 'bg-zinc-100', text: 'text-zinc-700', label: 'Pending' };
    case 'error':
      return { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Needs Attention' };
    case 'disconnected':
      return { bg: 'bg-zinc-200', text: 'text-zinc-700', label: 'Disconnected' };
    default:
      return { bg: 'bg-zinc-100', text: 'text-zinc-700', label: status };
  }
}

/**
 * 3-tier health-score chip for the analysis-derived DNS Health column on
 * `/inboxes` and `/pool`. Deliberately distinct from `scoreColor`'s 5-tier
 * reputation-score palette — this maps `inbox_analysis.health_score`
 * (0-100, DNS-only signal), not the multi-factor reputation score.
 */
export function healthScoreChipColor(score: number | null): {
  bg: string;
  text: string;
  label: string;
} {
  if (score === null) {
    return { bg: 'bg-zinc-100', text: 'text-zinc-600', label: 'Unknown' };
  }
  if (score >= 80) {
    return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Healthy' };
  }
  if (score >= 50) {
    return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Needs attention' };
  }
  return { bg: 'bg-rose-100', text: 'text-rose-700', label: 'At risk' };
}

/**
 * Status badge for `pool_inboxes.status` (`pending|active|removed|error`) —
 * a distinct enum from `inboxes.status` (`pending|active|paused|graduated|
 * error`), so `inboxStatusColor`'s existing `default` case would otherwise
 * just echo the raw string for 'removed'. Kept as a sibling helper rather
 * than overloading `inboxStatusColor`, since the two status sets only
 * partially overlap and mean different things ('active' here = enrolled in
 * the pool, not currently warming).
 */
export function poolInboxStatusColor(status: string): {
  bg: string;
  text: string;
  label: string;
} {
  switch (status) {
    case 'active':
      return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Active' };
    case 'pending':
      return { bg: 'bg-zinc-100', text: 'text-zinc-700', label: 'Pending' };
    case 'error':
      return { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Error' };
    case 'removed':
      return { bg: 'bg-zinc-200', text: 'text-zinc-700', label: 'Removed' };
    default:
      return { bg: 'bg-zinc-100', text: 'text-zinc-700', label: status };
  }
}

/**
 * Pool-inbox warming-readiness label — the user-facing question
 * "is this inbox actually safe to warm with?". A pool inbox can be in
 * `status='active'` (the analysis job has completed) and still have
 * failing DNS checks (DKIM missing, etc.) that would cause real
 * warmup emails to land in Spam rather than the inbox. This helper
 * returns a 4-state verdict that the badge and detail panel use to
 * surface that distinction.
 *
 *   - 'eligible'      → status='active' AND all critical DNS checks pass
 *                        (SPF + DKIM + DMARC + MX all `true`).
 *   - 'not-eligible'  → status='active' but at least one critical DNS
 *                        check is `false`. The inbox is "Active" in the
 *                        DB but it's NOT safe to use as a warmup peer.
 *   - 'analyzing'     → status='pending' (analysis job hasn't run yet
 *                        or just completed but no row yet). Display
 *                        as "Analysing…".
 *   - 'error'         → status='error' (analysis job failed). The
 *                        `errorMessage` field carries the reason.
 *
 * Critical DNS checks are SPF + DKIM + DMARC + MX. rDNS is excluded —
 * it's info-severity per the T011 addendum and doesn't affect
 * deliverability for the receiving inbox. Health score is
 * deliberately not used as the criterion (a 60 health score is
 * "Needs attention" but might still be safe to warm with; what
 * actually matters for the receiving inbox is whether the critical
 * authentication records are in place).
 */
export type PoolInboxReadiness = 'eligible' | 'not-eligible' | 'analyzing' | 'error';

export function poolInboxReadiness(
  status: string | null | undefined,
  analysis: { spfValid: boolean | null; dkimValid: boolean | null; dmarcValid: boolean | null; mxValid: boolean | null; rdnsValid: boolean | null } | null | undefined,
): PoolInboxReadiness {
  if (status === 'error') return 'error';
  if (status === 'pending' || !analysis) return 'analyzing';
  const allCritical =
    analysis.spfValid === true &&
    analysis.dkimValid === true &&
    analysis.dmarcValid === true &&
    analysis.mxValid === true;
  return allCritical ? 'eligible' : 'not-eligible';
}

export function poolInboxReadinessStyle(r: PoolInboxReadiness): {
  bg: string;
  text: string;
  label: string;
  /** Plain-language explanation shown in the detail panel and the
   *  tooltip on the badge. */
  hint: string;
} {
  switch (r) {
    case 'eligible':
      return {
        bg: 'bg-emerald-100',
        text: 'text-emerald-700',
        label: 'Ready',
        hint: 'All critical DNS records are in place. Safe to use as a warmup peer.',
      };
    case 'not-eligible':
      return {
        bg: 'bg-amber-100',
        text: 'text-amber-700',
        label: 'Needs attention',
        hint: 'One or more critical DNS records are missing. Warmup emails may land in Spam.',
      };
    case 'analyzing':
      return {
        bg: 'bg-zinc-100',
        text: 'text-zinc-600',
        label: 'Analysing…',
        hint: 'DNS analysis is running. This usually takes a few seconds.',
      };
    case 'error':
      return {
        bg: 'bg-rose-100',
        text: 'text-rose-700',
        label: 'Error',
        hint: 'Analysis failed. Re-analyze to retry, or check the error message.',
      };
  }
}

export function dnsStatusColor(valid: boolean | null): {
  bg: string;
  text: string;
  label: string;
} {
  if (valid === null) {
    return { bg: 'bg-zinc-100', text: 'text-zinc-600', label: 'Unknown' };
  }
  if (valid) {
    return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Valid' };
  }
  return { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Failing' };
}

export function trendArrow(trend: 'up' | 'down' | 'stable'): {
  symbol: string;
  color: string;
} {
  if (trend === 'up') return { symbol: '↑', color: 'text-emerald-600' };
  if (trend === 'down') return { symbol: '↓', color: 'text-rose-600' };
  return { symbol: '→', color: 'text-zinc-500' };
}

export function providerIcon(provider: string): string {
  if (provider === 'gmail') return 'G';
  if (provider === 'outlook') return 'O';
  return '@';
}
