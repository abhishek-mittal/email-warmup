import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { getInboxes } from '@/app/(dashboard)/_lib/data';
import { InboxRow } from '@/app/(dashboard)/_components/InboxRow';
import { PageHeader, primaryAction, secondaryAction } from '@/components/ui/PageHeader';
import { StatStrip } from '@/components/ui/StatStrip';

export const dynamic = 'force-dynamic';

const STEPS = [
  {
    title: 'Connect an inbox',
    body: 'Sign in with Google or Microsoft, or add any SMTP and IMAP server. We check it can send and receive before anything starts.',
  },
  {
    title: 'It warms up on its own',
    body: 'Small, spaced, human-looking exchanges that grow day by day. Each message is opened, starred, answered and filed away for you.',
  },
  {
    title: 'Watch it earn trust',
    body: 'Your score combines DNS records, blocklists and real inbox placement. It only counts what we could actually measure.',
  },
];

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const inboxes = await getInboxes();
  const active = inboxes.filter((i) => i.status === 'active');
  const attention = inboxes.filter((i) => ['error', 'pending', 'disconnected'].includes(i.status));
  const paused = inboxes.filter((i) => i.status === 'paused');
  const scored = inboxes.filter((i) => i.score != null) as Array<{ score: number }>;
  const avgScore = scored.length
    ? Math.round(scored.reduce((sum, i) => sum + i.score, 0) / scored.length)
    : null;

  // Worst first: what needs the owner, then the lowest scores.
  const needsYou = [...attention, ...paused];
  const rest = inboxes
    .filter((i) => !needsYou.includes(i))
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Overview"
        title="How your inboxes are doing"
        description={
          inboxes.length === 0
            ? 'Connect an inbox and EmailWarm starts building its sender reputation.'
            : `${inboxes.length} ${inboxes.length === 1 ? 'inbox' : 'inboxes'} connected.`
        }
        actions={
          <>
            <Link href="/inboxes" className={secondaryAction}>
              All inboxes
            </Link>
            <Link href="/inboxes/connect" className={primaryAction}>
              Connect inbox
            </Link>
          </>
        }
      />

      {inboxes.length === 0 ? (
        <section aria-labelledby="start-heading" className="rounded-xl border border-stone-200 bg-white p-6 sm:p-8">
          <h2 id="start-heading" className="text-lg font-semibold text-stone-900">
            Start in about two minutes
          </h2>
          <ol className="mt-5 grid gap-6 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 font-mono text-xs font-medium text-brand-700">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-sm font-medium text-stone-900">{step.title}</h3>
                  <p className="mt-1 text-sm text-stone-600">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <Link href="/inboxes/connect" className={`${primaryAction} mt-6`}>
            Connect your first inbox
          </Link>
        </section>
      ) : (
        <>
          <StatStrip
            stats={[
              { label: 'Inboxes', value: inboxes.length, hint: 'connected' },
              { label: 'Warming', value: active.length, hint: 'sending now', tone: active.length ? 'good' : 'neutral' },
              {
                label: 'Average score',
                value: avgScore ?? '—',
                hint: avgScore == null ? 'nothing measured yet' : 'of measured inboxes',
              },
              {
                label: 'Need you',
                value: needsYou.length,
                hint: needsYou.length ? 'paused or failing' : 'all clear',
                tone: needsYou.length ? 'bad' : 'good',
              },
            ]}
          />

          {needsYou.length > 0 ? (
            <section aria-labelledby="needs-heading" className="overflow-hidden rounded-xl border border-rose-200 bg-white">
              <h2 id="needs-heading" className="flex items-center gap-2 border-b border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-800 sm:px-5">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />
                Needs your attention
                <span className="font-mono text-xs tabular-nums text-rose-600">{needsYou.length}</span>
              </h2>
              <ul className="divide-y divide-stone-100">
                {needsYou.map((inbox) => (
                  <InboxRow key={inbox.id} inbox={inbox} />
                ))}
              </ul>
            </section>
          ) : null}

          {rest.length > 0 ? (
            <section aria-labelledby="warming-heading" className="overflow-hidden rounded-xl border border-stone-200 bg-white">
              <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5 sm:px-5">
                <h2 id="warming-heading" className="eyebrow">
                  Inboxes <span className="ml-1 tabular-nums">{rest.length}</span>
                </h2>
                <p className="text-xs text-stone-500">Lowest scores first</p>
              </div>
              <ul className="divide-y divide-stone-100">
                {rest.map((inbox) => (
                  <InboxRow key={inbox.id} inbox={inbox} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
