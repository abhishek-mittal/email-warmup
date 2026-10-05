'use client';

import Link from 'next/link';
import { FlowPage } from '@/components/kit/FlowPage';
import { Avatar } from '@/components/kit/ui';
import { WORKSPACES } from '@/mock/chrome';

function Body() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-stone-900">Choose a workspace</h1>
      <p className="mb-6 text-sm text-stone-600">You belong to more than one.</p>
      <ul className="space-y-2">{WORKSPACES.map((w) => <li key={w.id}><Link href="/" className="flex items-center gap-3 rounded-lg border border-stone-200 p-3 hover:border-brand-300 hover:bg-brand-50/40"><Avatar name={w.name} /><span className="text-sm font-medium text-stone-900">{w.name}</span></Link></li>)}</ul>
      <Link href="/onboarding" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">Create a new workspace</Link>
    </>
  );
}
export default function Page() { return <FlowPage feature="select_org"><Body /></FlowPage>; }
