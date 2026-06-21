import { redirect, notFound } from 'next/navigation';
import { currentUserId, serverApi } from '@/lib/api-server';
import { RequestAnalysisButton } from '@/app/(dashboard)/inboxes/[id]/diagnostics/_components/RequestAnalysisButton';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');
  const { id } = await params;

  let diagnostics: { issueCodes?: string[]; createdAt?: string | null };
  try {
    diagnostics = await serverApi<{ issueCodes?: string[]; createdAt?: string | null }>(`/inboxes/${id}/diagnostics`);
  } catch (err: unknown) {
    const e2 = err as { status?: number };
    if (e2?.status === 404) notFound();
    throw err;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-slate-900">Diagnostics</h1>
          <RequestAnalysisButton inboxId={id} canRun={true} />
        </header>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-700">Detected issues</h2>
          {diagnostics.issueCodes?.length ? (
            <ul className="mt-3 space-y-1 text-sm text-slate-700">
              {diagnostics.issueCodes.map((c: string) => (
                <li key={c} className="font-mono">{c}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No issues detected.</p>
          )}
        </div>
    </div>
  );
}