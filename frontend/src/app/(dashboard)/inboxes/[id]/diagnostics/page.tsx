import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { serverApi } from '@/lib/api-server';
import { RequestAnalysisButton } from './_components/RequestAnalysisButton';
import { getIssueEntry } from '@/lib/issue-catalog';
import { hasFeature } from '@/lib/plan-config';
import { formatDateTime } from '@/lib/format';
import type { DiagnosticsResponse, BillingStatus, Plan } from '@/lib/types';

export const dynamic = 'force-dynamic';

const SEVERITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Critical' },
  warning: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Warning' },
  info: { bg: 'bg-sky-100', text: 'text-sky-700', label: 'Info' },
};

export default async function DiagnosticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const { id } = await params;

  // Ensure the inbox belongs to the user
  const inboxes = await serverApi<Array<{ id: string }>>('/inboxes').catch(() => []);
  if (!inboxes.find((i) => i.id === id)) notFound();

  const [diag, billing] = await Promise.all([
    serverApi<DiagnosticsResponse>(`/inboxes/${id}/diagnostics`).catch(
      () => ({ issueCodes: [], aiAnalysis: null, readinessReport: null, createdAt: null }) as DiagnosticsResponse,
    ),
    serverApi<BillingStatus>('/billing/status').catch(
      () => ({ plan: 'trial' as Plan, trialEndsAt: null, inboxesUsed: 0, inboxLimit: 0, billingPortalUrl: null }),
    ),
  ]);

  const canRunAi = hasFeature(billing.plan, 'growth');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/inboxes/${id}`}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
        >
          ← Back to inbox
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
          AI diagnostics
        </h1>
        {diag.createdAt ? (
          <p className="mt-1 text-sm text-slate-600">
            Last analysis: {formatDateTime(diag.createdAt)}
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-600">No analysis has been run yet.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Issue list</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Each detected issue includes a plain-language explanation and ordered fix steps.
          </p>
        </div>
        <RequestAnalysisButton inboxId={id} canRun={canRunAi} />
      </div>

      {diag.issueCodes.length === 0 ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-800">
          <h2 className="text-sm font-semibold">No issues detected</h2>
          <p className="mt-1">
            This inbox is clean. Keep sending warmup traffic and monitoring placement to maintain
            the score.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {diag.issueCodes.map((code) => {
            const entry = getIssueEntry(code);
            const sev = SEVERITY_STYLES[entry.severity] ?? SEVERITY_STYLES.info;
            return (
              <div
                key={code}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">{entry.title}</h3>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-400">
                      {entry.code}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${sev.bg} ${sev.text}`}
                  >
                    {sev.label}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-700">{entry.explanation}</p>
                <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
                  {entry.fixSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      )}

      {diag.aiAnalysis ? (
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">AI root-cause analysis</h2>
          <p className="mt-1 text-sm text-slate-700">{diag.aiAnalysis.primaryCause}</p>
          {diag.aiAnalysis.estimatedRecoveryDays ? (
            <p className="mt-3 text-xs text-slate-500">
              Estimated recovery: <span className="font-medium">{diag.aiAnalysis.estimatedRecoveryDays} days</span> if
              you apply the fixes above.
            </p>
          ) : null}
        </div>
      ) : null}

      {diag.readinessReport ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Readiness report</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Generated at {formatDateTime(diag.readinessReport.generatedAt)}.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Reputation"
              value={Math.round(diag.readinessReport.reputationScore)}
              hint="0–100 composite"
            />
            <Stat
              label="Primary placement"
              value={
                diag.readinessReport.primaryPlacementPct == null
                  ? '—'
                  : `${Math.round(diag.readinessReport.primaryPlacementPct)}%`
              }
              hint="Last placement test"
            />
            <Stat
              label="Recommended volume"
              value={`${diag.readinessReport.recommendedDailySendVolume}/day`}
              hint="Cap-respecting"
            />
            <Stat
              label="Warmup days"
              value={`${diag.readinessReport.warmupDaysCompleted}`}
              hint="Completed"
            />
          </div>

          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            {diag.readinessReport.warmupPoolContribution}
          </div>

          {diag.readinessReport.nextSteps.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Next steps
              </h3>
              <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                {diag.readinessReport.nextSteps.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-slate-400">•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {diag.readinessReport.riskFactors.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Risk factors
              </h3>
              <ul className="mt-2 space-y-1.5 text-sm text-rose-700">
                {diag.readinessReport.riskFactors.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-rose-400">•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
      <p className="text-[10px] text-slate-500">{hint}</p>
    </div>
  );
}
