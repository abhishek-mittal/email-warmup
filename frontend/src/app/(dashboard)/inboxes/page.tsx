import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { getInboxes } from '@/app/(dashboard)/_lib/data';
import { InboxListTable } from '@/app/(dashboard)/_components/InboxListTable';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { StatStrip } from '@/components/ui/StatStrip';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const inboxes = await getInboxes();

  const count = (...statuses: string[]) => inboxes.filter((i) => statuses.includes(i.status)).length;
  const scored = inboxes.filter((i) => i.score != null) as Array<{ score: number }>;
  const avgScore = scored.length
    ? Math.round(scored.reduce((sum, i) => sum + i.score, 0) / scored.length)
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Warmup"
        title="Inboxes"
        description="Every inbox connected to your account. Tick rows to pause or resume warmup in bulk."
        actions={
          <Link href="/inboxes/connect" className={primaryAction}>
            Connect inbox
          </Link>
        }
      />

      {inboxes.length > 0 ? (
        <StatStrip
          stats={[
            { label: 'Total', value: inboxes.length, hint: 'connected' },
            { label: 'Warming', value: count('active'), hint: 'sending now', tone: count('active') ? 'good' : 'neutral' },
            { label: 'Paused', value: count('paused'), hint: 'resumable', tone: count('paused') ? 'warn' : 'neutral' },
            {
              label: 'Need attention',
              value: count('error', 'pending', 'disconnected'),
              hint: avgScore == null ? 'no scores yet' : `average score ${avgScore}`,
              tone: count('error', 'pending', 'disconnected') ? 'bad' : 'neutral',
            },
          ]}
        />
      ) : null}

      <InboxListTable inboxes={inboxes} />
    </div>
  );
}
