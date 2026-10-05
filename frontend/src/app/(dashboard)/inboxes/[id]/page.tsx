import { redirect, notFound } from 'next/navigation';
import { currentUserId, serverApi } from '@/lib/api-server';
import type { ScoreHistoryResponse } from '@/lib/activity-types';
import { InboxPageHeader } from './_components/InboxPageHeader';
import { InboxDashboardTabs } from './_components/InboxDashboardTabs';
import { InboxControlButtons } from '@/app/(dashboard)/_components/InboxControlButtons';
import { PoolParticipation } from './_components/PoolParticipation';

export const dynamic = 'force-dynamic';

interface InboxResponse {
  id: string;
  email: string;
  provider: string;
  status: string;
  statusReason?: string | null;
  poolConsentAt?: string | null;
  warmupDay: number;
  // T013 also attaches `analysis`, `warmupSpeed`, etc. We only need a
  // handful here, but the server-side inbox response is the same
  // object — pass through.
  [key: string]: unknown;
}

/**
 * Inbox detail page → full activity dashboard (T027). The server
 * component fetches the inbox row + score history once on mount,
 * passes them as props to the client header (sparkline + trend) and
 * the tabbed dashboard (5 tabs of data). Each tab fetches its own
 * data on demand — see InboxDashboardTabs.
 *
 * The "Run Placement Test" button moved into the Placement tab
 * (per T027 §4 Tab 4). A link to the diagnostics page is preserved
 * below the dashboard for users who want the deeper AI analysis.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');
  const { id } = await params;

  let inbox: InboxResponse;
  try {
    inbox = await serverApi<InboxResponse>(`/inboxes/${id}`);
  } catch (err: unknown) {
    const e2 = err as { status?: number };
    if (e2?.status === 404) notFound();
    throw err;
  }

  // Score history is independent of the inbox row and may 404/empty if
  // the inbox has never had a score computed. Treat the absence as a
  // legitimate "no score yet" state — no need to surface an error.
  let scoreHistory: ScoreHistoryResponse | null = null;
  try {
    scoreHistory = await serverApi<ScoreHistoryResponse>(`/inboxes/${id}/score-history?days=30`);
  } catch {
    scoreHistory = { current: null, trend: 'stable', history: [] };
  }

  return (
    <div className="space-y-8">
      <InboxPageHeader
        email={inbox.email}
        provider={inbox.provider}
        status={inbox.status}
        warmupDay={inbox.warmupDay ?? 0}
        score={scoreHistory}
      />

      <PoolParticipation
        inboxId={inbox.id}
        status={inbox.status}
        statusReason={inbox.statusReason ?? null}
        poolConsentAt={inbox.poolConsentAt ?? null}
      />

      {/* Page-level Pause/Resume. The same component also shows up as a
          per-row button in the inbox list — `size="md"` here gives it
          more padding for the page header. */}
      <div className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex-1">
          <p className="text-sm font-medium text-stone-900">Warmup control</p>
          <p className="text-xs text-stone-500">
            Pause stops all pending send and receive jobs and freezes the daily schedule.
            Resume re-queues today&rsquo;s sends immediately — no need to wait for the 05:00 UTC cron.
          </p>
        </div>
        <InboxControlButtons inboxId={inbox.id} status={inbox.status} size="md" />
      </div>

      <InboxDashboardTabs inboxId={inbox.id} />

      <a
        className="inline-block text-sm text-brand-600 hover:underline"
        href={`/inboxes/${id}/diagnostics`}
      >
        View diagnostics →
      </a>
    </div>
  );
}