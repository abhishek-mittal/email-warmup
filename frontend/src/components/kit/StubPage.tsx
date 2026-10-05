'use client';

import Link from 'next/link';
import { useFeatures } from '@/features/FeatureProvider';
import { FEATURE_BY_ID } from '@/features/registry';

/**
 * Wraps a front-end-only screen. Shows a clear "preview" strip so nobody
 * mistakes sample data for real data, and swaps the content for a notice when
 * the owner has hidden the feature.
 */
export function StubPage({ feature, children }: { feature: string; children: React.ReactNode }) {
  const { isEnabled, setEnabled } = useFeatures();
  const def = FEATURE_BY_ID[feature];

  if (!isEnabled(feature)) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-stone-200 bg-white p-8 text-center">
        <p className="eyebrow">Hidden</p>
        <h1 className="mt-2 text-lg font-semibold text-stone-900">{def?.label ?? 'This feature'} is hidden</h1>
        <p className="mt-1 text-sm text-stone-500">You switched it off in Feature review. Nothing is lost; turn it back on any time.</p>
        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => setEnabled(feature, true)}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700"
          >
            Show it again
          </button>
          <Link href="/features" className="rounded-lg border border-stone-300 px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50">
            Feature review
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50/60 px-3 py-2 text-xs text-brand-900">
        <span>
          <strong className="font-semibold">Preview.</strong> Sample data only; this screen isn’t connected to the backend.
        </span>
        <Link href="/features" className="font-medium underline-offset-2 hover:underline">
          Keep or hide this feature
        </Link>
      </div>
      {children}
    </div>
  );
}
