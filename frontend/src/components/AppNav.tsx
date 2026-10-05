'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useShellSummary } from './ShellData';
import { useFeatures } from '@/features/FeatureProvider';
import { FEATURE_BY_ID } from '@/features/registry';

const Icon = ({ d }: { d: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-[18px] w-[18px] shrink-0"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  featureId?: string;
  badge?: 'inboxes';
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const ICONS: Record<string, string> = {
  overview: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  inboxes: 'M3 6h18v12H3z M3 7l9 6 9-6',
  analytics: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  deliverability: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z M9 12l2 2 4-4',
  pool: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12l8.73-5.04 M12 22.08V12',
  templates: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8',
  api_keys: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z M15.5 7.5l3 3L22 7l-3-3',
  audit: 'M9 11l3 3L22 4 M3 6h6 M3 12h6 M3 18h12',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  billing: 'M3 10h18M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  account: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  features: 'M4 6h16 M4 12h16 M4 18h16 M8 4v4 M16 10v4 M10 16v4',
};

const icon = (key: string) => <Icon d={ICONS[key] ?? ICONS.overview} />;

function fromFeature(id: string, label?: string, key?: string): NavItem {
  const f = FEATURE_BY_ID[id];
  return { href: f.href, label: label ?? f.label, icon: icon(key ?? id), featureId: id, badge: id === 'inboxes' ? 'inboxes' : undefined };
}

const GROUPS: NavGroup[] = [
  { items: [{ href: '/', label: 'Overview', icon: icon('overview') }] },
  {
    label: 'Email',
    items: [
      fromFeature('inboxes', 'Accounts', 'inboxes'),
      fromFeature('analytics'),
      fromFeature('deliverability'),
      fromFeature('pool', 'Warming pool'),
    ],
  },
  {
    label: 'Resources',
    items: [
      fromFeature('templates'),
      fromFeature('api_keys', 'API keys'),
      fromFeature('audit', 'Audit log'),
    ],
  },
];

const FOOTER_ITEMS: NavItem[] = [
  { href: '/settings/profile', label: 'Settings', icon: icon('settings') },
  { href: '/billing', label: 'Plan & credits', icon: icon('billing') },
  { href: '/account', label: 'Account', icon: icon('account') },
  { href: '/features', label: 'Feature review', icon: icon('features') },
];

/** The nav item whose route best matches, so /inboxes/connect does not also light up /inboxes. */
function activeHref(pathname: string, hrefs: string[]): string | null {
  const matches = hrefs.filter((href) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`),
  );
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function AppNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const summary = useShellSummary();
  const { isEnabled } = useFeatures();

  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.featureId || isEnabled(i.featureId)),
  })).filter((g) => g.items.length > 0);
  const all = [...groups.flatMap((g) => g.items), ...FOOTER_ITEMS];
  const current = activeHref(pathname, all.map((i) => i.href));

  function badgeFor(item: NavItem): string | null {
    if (summary.state !== 'ready') return null;
    if (item.badge === 'inboxes' && summary.total > 0) return String(summary.total);
    return null;
  }

  function renderItem(item: NavItem) {
    const isActive = item.href === current;
    const badge = badgeFor(item);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={isActive ? 'page' : undefined}
        className={`group flex h-8 items-center gap-3 rounded-lg px-3 text-[13px] transition-colors ${
          isActive ? 'bg-brand-50 font-medium text-brand-800' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
        }`}
      >
        <span className={isActive ? 'text-brand-600' : 'text-stone-400 group-hover:text-stone-600'}>{item.icon}</span>
        <span className="flex-1 truncate">{item.label}</span>
        {badge ? <span className="font-mono text-[11px] tabular-nums text-stone-400">{badge}</span> : null}
      </Link>
    );
  }

  return (
    <nav aria-label="Main" className="flex flex-col gap-4">
      {groups.map((group, index) => (
        <div key={group.label ?? index} className="flex flex-col gap-0.5">
          {group.label ? <p className="eyebrow px-3 pb-1">{group.label}</p> : null}
          {group.items.map(renderItem)}
        </div>
      ))}
      <div className="flex flex-col gap-0.5 border-t border-stone-200 pt-3">{FOOTER_ITEMS.map(renderItem)}</div>
    </nav>
  );
}
