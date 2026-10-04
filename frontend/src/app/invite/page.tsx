'use client';

import Link from 'next/link';
import { FlowPage } from '@/components/kit/FlowPage';
import { useNotify } from '@/components/kit/Notify';
import { btnPrimary } from '@/components/kit/ui';

function Body() {
  const { preview } = useNotify();
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-stone-900">Join Acme Outbound</h1>
      <p className="mb-6 text-sm text-stone-600">Priya Raman invited riley@acme-outbound.io as a Member.</p>
      <button type="button" className={`${btnPrimary} w-full justify-center`} onClick={() => preview('Accepting the invitation')}>Accept invitation</button>
      <Link href="/sign-in" className="mt-4 inline-block text-sm text-stone-600 hover:underline">Sign in with a different account</Link>
    </>
  );
}
export default function Page() { return <FlowPage feature="invite"><Body /></FlowPage>; }
