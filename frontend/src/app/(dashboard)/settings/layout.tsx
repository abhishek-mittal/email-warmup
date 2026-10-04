'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { StubPage } from '@/components/kit/StubPage';
import { useFeatures } from '@/features/FeatureProvider';
import { FEATURES } from '@/features/registry';

const SETTINGS = FEATURES.filter((f) => f.group === 'settings');

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isEnabled } = useFeatures();
  const current = SETTINGS.find((f) => pathname === f.href || pathname.startsWith(`${f.href}/`));
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        <p className="eyebrow mb-1 hidden px-2.5 lg:block">Settings</p>
        {SETTINGS.filter((f) => isEnabled(f.id)).map((f) => (
          <Link key={f.id} href={f.href} aria-current={f === current ? 'page' : undefined} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] ${f === current ? 'bg-brand-50 font-medium text-brand-800' : 'text-stone-600 hover:bg-stone-100'}`}>{f.label}</Link>
        ))}
      </nav>
      <div className="min-w-0 max-w-4xl">
        <StubPage feature={current?.id ?? 's_profile'}>{children}</StubPage>
      </div>
    </div>
  );
}
