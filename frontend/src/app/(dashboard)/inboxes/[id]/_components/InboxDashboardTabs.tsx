'use client';

import { useState } from 'react';
import { ActivityFeedTab } from './ActivityFeedTab';
import { SentEmailsTab } from './SentEmailsTab';
import { DnsBlacklistTab } from './DnsBlacklistTab';
import { PlacementTab } from './PlacementTab';
import { LogsTab } from './LogsTab';

interface Props {
  inboxId: string;
}

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: 'activity', label: 'Activity Feed', hint: 'What just happened to this inbox' },
  { id: 'sends', label: 'Sent Emails', hint: 'Every warmup email sent from this inbox' },
  { id: 'dns', label: 'DNS & Blacklist', hint: 'Authentication records + reputation listings' },
  { id: 'placement', label: 'Placement', hint: 'Where warmup emails land (Primary/Promo/Spam)' },
  { id: 'logs', label: 'Logs', hint: 'Raw structured log stream for this inbox' },
];

type TabId = 'activity' | 'sends' | 'dns' | 'placement' | 'logs';

/**
 * Top-level tabbed shell for the inbox activity dashboard. Renders the
 * tab bar at the top and switches the active tab body in place.
 * Default tab is "Activity Feed" per T027 §4.
 */
export function InboxDashboardTabs({ inboxId }: Props) {
  const [active, setActive] = useState<TabId>('activity');

  return (
    <div>
      <nav
        role="tablist"
        aria-label="Inbox activity tabs"
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
        {active === 'activity' ? <ActivityFeedTab inboxId={inboxId} /> : null}
        {active === 'sends' ? <SentEmailsTab inboxId={inboxId} /> : null}
        {active === 'dns' ? <DnsBlacklistTab inboxId={inboxId} /> : null}
        {active === 'placement' ? <PlacementTab inboxId={inboxId} /> : null}
        {active === 'logs' ? <LogsTab inboxId={inboxId} /> : null}
      </div>
    </div>
  );
}