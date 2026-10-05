'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, ApiError } from '@/lib/api';
import { Toast, useToasts } from '@/components/Toast';

/**
 * Client-side preview row. Mirrors the column detection in
 * `backend/src/common/csv-parser.ts` (header lowercase, comma-split, no
 * quoted-field support — the documented columns never contain commas).
 * This parse is PREVIEW ONLY — the authoritative parse happens server-side
 * when the raw file is uploaded.
 */
interface PreviewRow {
  email: string;
  provider: string;
  missing: string[];
  detected: string[];
}

const OAUTH_COLUMNS = ['client_id', 'client_secret', 'refresh_token'];
const CUSTOM_COLUMNS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_password',
  'imap_host',
  'imap_port',
  'imap_user',
  'imap_password',
];

function parseCsvPreview(csv: string): PreviewRow[] {
  const lines = csv.split(/\r\n|\n|\r/);
  if (lines.length === 0) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const colIndex = (name: string) => header.indexOf(name);

  const rows: PreviewRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const cells = line.split(',').map((c) => c.trim());
    const get = (name: string) => {
      const idx = colIndex(name);
      return idx === -1 ? '' : (cells[idx] ?? '');
    };

    const email = get('email');
    const provider = get('provider').toLowerCase();
    const missing: string[] = [];
    const detected: string[] = [];

    if (!email) missing.push('email');

    if (provider === 'gmail' || provider === 'outlook') {
      for (const col of OAUTH_COLUMNS) {
        if (get(col)) detected.push(col);
        else missing.push(col);
      }
    } else if (provider === 'custom') {
      for (const col of CUSTOM_COLUMNS) {
        if (get(col)) detected.push(col);
        else missing.push(col);
      }
    } else {
      missing.push('provider');
    }

    rows.push({ email, provider, missing, detected });
  }
  return rows;
}

interface Props {
  endpoint: '/inboxes/batch/csv' | '/pool-inboxes/batch/csv';
  label?: string;
  /** Called after a successful upload so the parent can start polling
   *  for the analysis rows to appear. */
  onUploaded?: () => void;
}

export function BatchUploadCsv({ endpoint, label = 'Add via CSV', onUploaded }: Props) {
  const api = useApi();
  const router = useRouter();
  const { toast, show, clear } = useToasts();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    failed: { email: string; reason: string }[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setRows(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function closeModal() {
    setOpen(false);
    reset();
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setResult(null);
    setFile(selected);
    if (!selected) {
      setRows(null);
      return;
    }
    const text = await selected.text();
    setRows(parseCsvPreview(text));
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api<{ created: number; failed: { email: string; reason: string }[] }>(
        endpoint,
        { method: 'POST', body: formData },
      );
      setResult(res);
      show(`${res.created} added successfully, ${res.failed.length} failed.`, res.failed.length ? 'info' : 'success');
      // Tell the parent page to start polling for analysis completion
      // (the DNS / OAuth checks run async in a BullMQ worker).
      onUploaded?.();
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body : 'Failed to upload CSV';
      show(msg || 'Failed to upload CSV', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
      >
        {label}
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-stone-900/40 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-stone-900">Add via CSV</h2>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
              >
                ✕
              </button>
            </div>

            <p className="mt-1 text-sm text-stone-600">
              Columns: <code className="font-mono text-xs">email,provider,client_id,client_secret,refresh_token</code>{' '}
              for gmail/outlook, or{' '}
              <code className="font-mono text-xs">
                email,provider,smtp_host,smtp_port,smtp_user,smtp_password,imap_host,imap_port,imap_user,imap_password
              </code>{' '}
              for custom. Mixed providers in one file are fine.
            </p>

            <label className="mt-4 block text-sm">
              <span className="mb-1 block text-xs font-medium text-stone-700">CSV file</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={onFileSelected}
                className="block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </label>

            {rows && rows.length > 0 ? (
              <div className="mt-4 overflow-hidden rounded-xl border border-stone-200">
                <table className="min-w-full divide-y divide-stone-200 text-sm">
                  <thead className="bg-stone-50 text-left text-xs font-medium uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Provider</th>
                      <th className="px-3 py-2">Detected columns</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {rows.map((r, idx) => (
                      <tr key={idx} className={r.missing.length > 0 ? 'bg-amber-50' : undefined}>
                        <td className="px-3 py-2 font-medium text-stone-900">{r.email || '—'}</td>
                        <td className="px-3 py-2 capitalize text-stone-700">{r.provider || '—'}</td>
                        <td className="px-3 py-2 text-xs text-stone-600">
                          {r.detected.length > 0 ? r.detected.join(', ') : '—'}
                          {r.missing.length > 0 ? (
                            <span className="ml-2 font-medium text-amber-700">
                              missing: {r.missing.join(', ')}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {rows && rows.length === 0 ? (
              <p className="mt-4 text-sm text-stone-500">No rows found in this file.</p>
            ) : null}

            {result ? (
              <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm">
                <p className="font-medium text-stone-900">
                  {result.created} added successfully, {result.failed.length} failed.
                </p>
                {result.failed.length > 0 ? (
                  <ul className="mt-2 list-inside list-disc space-y-1 text-rose-700">
                    {result.failed.map((f, idx) => (
                      <li key={idx}>
                        {f.email}: {f.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={upload}
                disabled={!file || busy}
                className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <Toast message={toast.message} kind={toast.kind} onDone={clear} /> : null}
    </>
  );
}
