'use client';

import { useState } from 'react';
import Link from 'next/link';
import { InboxStatusBadge } from '@/components/InboxStatusBadge';
import { HealthChip, IssuesCell } from './AnalysisCells';
import { InboxControlButtons } from './InboxControlButtons';
import { BulkInboxActions } from './BulkInboxActions';
import type { InboxListItem } from '@/app/(dashboard)/_lib/data';

interface Props {
  inboxes: InboxListItem[];
}

/**
 * Client wrapper for the inbox list table. Owns row selection state
 * so the bulk pause/resume bar can react to checkbox changes
 * without the parent server component re-rendering.
 *
 * Why a client component: every row in the original (T018) table was
 * a server-rendered <tr> with no interactivity. To support bulk
 * selection we need useState — so we promote the whole table to a
 * client component and pass the inboxes in as props. The
 * `router.refresh()` calls after each operation keep the rest of
 * the page (header cards, etc.) in sync.
 */
export function InboxListTable({ inboxes }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === inboxes.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(inboxes.map((i) => i.id)));
    }
  }

  const allSelected = inboxes.length > 0 && selected.size === inboxes.length;
  const someSelected = selected.size > 0 && selected.size < inboxes.length;

  return (
    <div className="space-y-4">
      {/* Bulk action bar — shows only when at least one row is selected */}
      <BulkInboxActions
        selectedIds={Array.from(selected)}
        onCleared={() => setSelected(new Set())}
      />

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label={allSelected ? 'Deselect all inboxes' : 'Select all inboxes'}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
              </th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Score</th>
              <th className="px-4 py-3">Speed</th>
              <th className="px-4 py-3">Day</th>
              <th className="px-4 py-3">Last placement</th>
              <th className="px-4 py-3">DNS Health</th>
              <th className="px-4 py-3">Issues</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {inboxes.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-sm text-slate-500">
                  No inboxes connected yet. Use the buttons above to connect one.
                </td>
              </tr>
            ) : (
              inboxes.map((i) => (
                <tr
                  key={i.id}
                  className={`hover:bg-slate-50 ${selected.has(i.id) ? 'bg-indigo-50/50' : ''}`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${i.email}`}
                      checked={selected.has(i.id)}
                      onChange={() => toggle(i.id)}
                      className="h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">{i.email}</td>
                  <td className="px-4 py-3">
                    <InboxStatusBadge status={i.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{i.score != null ? i.score : '—'}</td>
                  <td className="px-4 py-3 text-slate-600 capitalize">{i.warmupSpeed ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{i.warmupDay ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{i.lastPlacementAt ?? '—'}</td>
                  <td className="px-4 py-3">
                    <HealthChip analysis={i.analysis as never} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <IssuesCell analysis={i.analysis as never} status={i.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <InboxControlButtons inboxId={i.id} status={i.status} />
                      <Link
                        href={`/inboxes/${i.id}`}
                        className="rounded-full bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
                      >
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}