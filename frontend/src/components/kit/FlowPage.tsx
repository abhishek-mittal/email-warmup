'use client';

import Link from 'next/link';
import { AuthShell } from '@/components/brand/AuthShell';
import { FeatureProvider, useFeatures } from '@/features/FeatureProvider';
import { NotifyProvider } from '@/components/kit/Notify';
import { FEATURE_BY_ID } from '@/features/registry';

function Gate({ feature, children }: { feature: string; children: React.ReactNode }) {
  const { isEnabled } = useFeatures();
  if (!isEnabled(feature)) {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight text-stone-900">{FEATURE_BY_ID[feature]?.label ?? 'This screen'} is hidden</h1>
        <p className="mt-1 text-sm text-stone-600">Turn it back on in Feature review.</p>
        <Link href="/features" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">Feature review</Link>
      </>
    );
  }
  return (
    <>
      <p className="mb-4 rounded-md border border-dashed border-brand-300 bg-brand-50/60 px-3 py-1.5 text-xs text-brand-900"><strong className="font-semibold">Preview.</strong> Sample flow; nothing is saved.</p>
      {children}
    </>
  );
}

/** Standalone (outside the dashboard) preview screen on the auth layout, gated by the feature registry. */
export function FlowPage({ feature, children }: { feature: string; children: React.ReactNode }) {
  return (
    <FeatureProvider>
      <NotifyProvider>
        <AuthShell>
          <Gate feature={feature}>{children}</Gate>
        </AuthShell>
      </NotifyProvider>
    </FeatureProvider>
  );
}
