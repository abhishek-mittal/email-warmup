'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FlowPage } from '@/components/kit/FlowPage';
import { btnPrimary, btnSecondary, inputCls } from '@/components/kit/ui';

const STEPS = ['Workspace', 'Your goal', 'Connect a mailbox'] as const;
const GOALS = ['Warm new domains', 'Fix a deliverability problem', 'Protect a live sending setup'];

function Body() {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState(GOALS[0]);
  return (
    <>
      <ol className="mb-6 flex gap-1.5" aria-label="Progress">{STEPS.map((s, i) => <li key={s} aria-current={i === step ? 'step' : undefined} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-brand-600' : 'bg-stone-200'}`}><span className="sr-only">{s}</span></li>)}</ol>
      <p className="eyebrow">Step {step + 1} of {STEPS.length}</p>
      <h1 className="mb-4 mt-1 text-2xl font-semibold tracking-tight text-stone-900">{STEPS[step]}</h1>
      {step === 0 && <label className="block text-sm text-stone-700">Workspace name<input className={`${inputCls} mt-1`} defaultValue="Acme Outbound" /></label>}
      {step === 1 && <fieldset className="space-y-2"><legend className="sr-only">Goal</legend>{GOALS.map((g) => <label key={g} className="flex items-center gap-2 rounded-lg border border-stone-200 p-3 text-sm text-stone-800"><input type="radio" name="goal" checked={goal === g} onChange={() => setGoal(g)} className="accent-brand-600" />{g}</label>)}</fieldset>}
      {step === 2 && <p className="text-sm text-stone-600">Connect Google, Microsoft or any SMTP mailbox to start warming.</p>}
      <div className="mt-6 flex gap-2">
        {step > 0 && <button type="button" className={btnSecondary} onClick={() => setStep(step - 1)}>Back</button>}
        {step < STEPS.length - 1 ? <button type="button" className={btnPrimary} onClick={() => setStep(step + 1)}>Continue</button> : <Link href="/inboxes/connect" className={btnPrimary}>Connect a mailbox</Link>}
      </div>
    </>
  );
}
export default function Page() { return <FlowPage feature="onboarding"><Body /></FlowPage>; }
