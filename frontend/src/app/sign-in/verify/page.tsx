'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FlowPage } from '@/components/kit/FlowPage';
import { useNotify } from '@/components/kit/Notify';
import { btnPrimary, inputCls } from '@/components/kit/ui';

function Body() {
  const { preview } = useNotify();
  const [code, setCode] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); preview('Verifying the code'); }}>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-stone-900">Check your email</h1>
      <p className="mb-6 text-sm text-stone-600">We sent a 6-digit code to a***@acme-outbound.io. It expires in 10 minutes.</p>
      <label htmlFor="code" className="sr-only">Sign-in code</label>
      <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className={`${inputCls} text-center font-mono text-xl tracking-[0.4em]`} placeholder="000000" />
      <button type="submit" disabled={code.length !== 6} className={`${btnPrimary} mt-4 w-full justify-center`}>Verify</button>
      <p className="mt-4 text-sm text-stone-600">No code? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => preview('Resending the code')}>Resend</button> · <Link href="/sign-in" className="font-medium text-brand-700 hover:underline">Back to sign in</Link></p>
    </form>
  );
}
export default function Page() { return <FlowPage feature="login_verify"><Body /></FlowPage>; }
