'use client';

import Link from 'next/link';
import { useFeatures } from '@/features/FeatureProvider';
import { FEATURES, GROUP_LABELS, type FeatureGroup } from '@/features/registry';
import { PageHeader, secondaryAction } from '@/components/ui/PageHeader';
import { Pill, Toggle } from '@/components/kit/ui';

const ORDER: FeatureGroup[] = ['email', 'inbox', 'resources', 'settings', 'account', 'shell'];

/**
 * Keep-or-hide review of every screen in the app. Switches apply instantly in
 * this browser, so the whole product can be walked through with and without
 * each area before anything is removed from the code.
 */
export default function FeatureReviewPage() {
  const { isEnabled, setEnabled, setMany, reset, hiddenCount } = useFeatures();
  const total = FEATURES.length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Feature review"
        title="Keep or hide each part of the product"
        description={`${total - hiddenCount} of ${total} areas are showing. Hidden areas leave the navigation, search and routes in this browser; nothing is deleted.`}
        actions={
          <button type="button" onClick={reset} className={secondaryAction}>
            Show everything
          </button>
        }
      />

      {ORDER.map((group) => {
        const items = FEATURES.filter((f) => f.group === group);
        const ids = items.map((f) => f.id);
        const allOn = items.every((f) => isEnabled(f.id));
        return (
          <section key={group} aria-labelledby={`g-${group}`} className="overflow-hidden rounded-xl border border-stone-200 bg-white">
            <header className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5 sm:px-5">
              <h2 id={`g-${group}`} className="text-sm font-semibold text-stone-900">
                {GROUP_LABELS[group]} <span className="ml-1 font-mono text-xs font-normal text-stone-400">{items.length}</span>
              </h2>
              <button type="button" onClick={() => setMany(ids, !allOn)} className="text-xs font-medium text-brand-700 hover:underline">
                {allOn ? 'Hide all' : 'Show all'}
              </button>
            </header>
            <ul className="divide-y divide-stone-100">
              {items.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-stone-900">
                      {f.label}
                      <Pill tone={f.kind === 'real' ? 'good' : 'neutral'}>{f.kind === 'real' ? 'Connected' : 'Preview'}</Pill>
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">{f.description}</p>
                  </div>
                  {f.group !== 'shell' ? (
                    <Link href={f.href} className="hidden text-xs text-stone-500 hover:text-stone-800 hover:underline sm:block">
                      Open
                    </Link>
                  ) : null}
                  <Toggle checked={isEnabled(f.id)} onChange={(v) => setEnabled(f.id, v)} label={`Show ${f.label}`} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
