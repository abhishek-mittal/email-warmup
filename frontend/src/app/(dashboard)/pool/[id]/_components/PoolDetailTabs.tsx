'use client';

import { useState } from 'react';
import { PoolActivityTab } from '@/app/(dashboard)/pool/_components/PoolActivityTab';
import { PoolPairingsTab } from '@/app/(dashboard)/pool/_components/PoolPairingsTab';
import { PoolLogsTab } from '@/app/(dashboard)/pool/_components/PoolLogsTab';
import { PoolHealthTab } from './PoolHealthTab';
import type { PoolInbox } from '@/lib/types';

type TabId = 'activity' | 'health' | 'pairings' | 'logs';

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: 'activity', label: 'Activity', hint: 'Received emails and actions taken, most recent first' },
  { id: 'health', label: 'Health', hint: 'DNS records, readiness, and score' },
  { id: 'pairings', label: 'Pairings', hint: 'Which inboxes this one is currently serving' },
  { id: 'logs', label: 'Logs', hint: 'Raw structured log stream for this pool inbox' },
];

interface Props {
  poolInbox: PoolInbox;
}

/**
 * Tab shell for the `/pool/[id]` page. Default tab is Activity (not
 * Health, which was the old drawer's default) — paired with
 * `LiveStatusPanel` above this component, the page now reads top-to-
 * bottom as "happening now -> just happened -> history" without a tab
 * switch.
 */
export function PoolDetailTabs({ poolInbox }: Props) {
  const [active, setActive] = useState<TabId>('activity');

  return (
    <div>
      <nav
        role="tablist"
        aria-label="Pool inbox detail tabs"
        className="mb-4 flex flex-wrap gap-1 rounded-full border border-stone-200 bg-white p-1 text-sm shadow-sm"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              id={`tab-${tab.id}`}
              onClick={() => setActive(tab.id)}
              title={tab.hint}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-stone-600 hover:bg-stone-100'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel" id={`tabpanel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'activity' ? <PoolActivityTab poolInboxId={poolInbox.id} /> : null}
        {active === 'health' ? <PoolHealthTab poolInbox={poolInbox} /> : null}
        {active === 'pairings' ? <PoolPairingsTab poolInboxId={poolInbox.id} /> : null}
        {active === 'logs' ? <PoolLogsTab poolInboxId={poolInbox.id} /> : null}
      </div>
    </div>
  );
}
