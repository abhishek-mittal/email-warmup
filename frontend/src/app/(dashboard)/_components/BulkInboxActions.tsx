'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';
import { PulseDot } from '@/components/PulseDot';

interface Props {
  /** Inbox ids the user has selected in the parent table. */
  selectedIds: string[];
  /** Called to clear the parent's selection after a successful action. */
  onCleared: () => void;
}

interface BulkResult {
  updated: { id: string; status: string }[];
  failed: { id: string; reason: string }[];
}

/**
 * Sticky action bar that shows up above the inbox list when at least
 * one inbox is selected. Mirrors the per-row `InboxControlButtons`
 * but operates on a `string[]` and reports per-row results so a
 * single bad id (not owned, race condition) doesn't abort the whole
 * batch.
 *
 * "Pausing" turns into a confirmation step when more than 10 inboxes
 * are selected — bulk-pausing a big fleet is an easy mistake to
 * make by accident.
 */
export function BulkInboxActions({ selectedIds, onCleared }: Props) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState<'pause' | 'resume' | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const { toast, show, clear } = useToasts();

  if (selectedIds.length === 0) return null;

  async function run(action: 'pause' | 'resume') {
    if (busy) return;
    setBusy(action);
    try {
      const res = await api<BulkResult>(`/inboxes/${action}`, {
        method: 'POST',
        body: JSON.stringify({ inboxIds: selectedIds }),
      });
      const updated = res.updated.length;
      const failed = res.failed.length;
      const verb = action === 'pause' ? 'paused' : 'resumed';
      if (failed === 0) {
        show(`${updated} inbox${updated === 1 ? '' : 'es'} ${verb}.`, 'success');
      } else {
        show(
          `${updated} ${verb}, ${failed} skipped (not owned / not found).`,
          failed === selectedIds.length ? 'error' : 'info',
        );
      }
      onCleared();
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : e instanceof Error ? e.message : `Bulk ${action} failed`;
      show(msg || `Bulk ${action} failed`, 'error');
    } finally {
      setBusy(null);
      setConfirmPause(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm shadow-sm">
      <span className="font-medium text-indigo-900">
        {selectedIds.length} inbox{selectedIds.length === 1 ? '' : 'es'} selected
      </span>

      {/* Pause — single click when selection is small, two-click confirm when large */}
      {confirmPause && selectedIds.length > 10 ? (
        <>
          <span className="text-xs text-indigo-700">
            Pause {selectedIds.length} inboxes? Pending send jobs will be drained.
          </span>
          <button
            type="button"
            onClick={() => run('pause')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'pause' ? <PulseDot state="busy" size="xs" /> : null}
            {busy === 'pause' ? 'Pausing…' : 'Confirm pause'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmPause(false)}
            disabled={busy !== null}
            className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (selectedIds.length > 10) {
              setConfirmPause(true);
            } else {
              run('pause');
            }
          }}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'pause' ? <PulseDot state="busy" size="xs" /> : null}
          {busy === 'pause' ? 'Pausing…' : `Pause ${selectedIds.length}`}
        </button>
      )}

      <button
        type="button"
        onClick={() => run('resume')}
        disabled={busy !== null}
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy === 'resume' ? <PulseDot state="busy" size="xs" /> : null}
        {busy === 'resume' ? 'Resuming…' : `Resume ${selectedIds.length}`}
      </button>

      <button
        type="button"
        onClick={onCleared}
        disabled={busy !== null}
        className="ml-auto rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Clear selection
      </button>

      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </div>
  );
}