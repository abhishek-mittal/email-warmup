import { redirect, notFound } from 'next/navigation';
import { currentUserId } from '@/lib/api-server';
import { serverApi } from '@/lib/api-server';
import { DashboardShell } from '@/components/DashboardShell';
import { RunPlacementButton } from '@/app/(dashboard)/inboxes/[id]/_components/RunPlacementButton';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');
  const { id } = await params;

  let inbox: { id: string; email: string; provider: string; status: string; score: number | null };
  try {
    inbox = await serverApi<{ id: string; email: string; provider: string; status: string; score: number | null }>(`/inboxes/${id}`);
  } catch (err: unknown) {
    const e2 = err as { status?: number };
    if (e2?.status === 404) notFound();
    throw err;
  }

  return (
    <DashboardShell>
      <div className="space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">{inbox.email}</h1>
          <p className="text-sm text-slate-600 capitalize">{inbox.provider} · {inbox.status}</p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-700">Reputation</h2>
          <p className="mt-1 font-mono text-3xl text-slate-900">
            {inbox.score != null ? inbox.score : '—'}
          </p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-700">Placement</h2>
          <RunPlacementButton inboxId={inbox.id} disabled={false} />
        </section>

        <a className="inline-block text-sm text-indigo-600 hover:underline" href={`/inboxes/${id}/diagnostics`}>
          View diagnostics →
        </a>
      </div>
    </DashboardShell>
  );
}