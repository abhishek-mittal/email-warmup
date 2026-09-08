'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { PulseDot } from '@/components/PulseDot';
import type { LogLine, LogsResponse } from '@/lib/activity-types';

interface Props {
  inboxId: string;
}

type LevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';
type SinceFilter = '15m' | '1h' | '6h' | '24h' | 'all';

const FOLLOW_INTERVAL_MS = 5000;
const MAX_LINES = 200;

/**
 * Terminal-style viewer for the structured NDJSON logs filtered to one
 * inbox. Polls every 5 seconds when "Follow" is on, otherwise loads
 * once when the tab mounts.
 *
 * The backend reads the NDJSON file directly from `.bin/.runtime/
 * backend.ndjson` (T025) — no DB write, no log shipping. In
 * production (where the file isn't written) the backend returns
 * `{ fileFound: false }` and we show a soft "logs not available"
 * banner instead of an error.
 */
export function LogsTab({ inboxId }: Props) {
  const api = useApi();
  const [level, setLevel] = useState<LevelFilter>('all');
  const [since, setSince] = useState<SinceFilter>('1h');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);

  const [lines, setLines] = useState<LogLine[]>([]);
  const [fileFound, setFileFound] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const followTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const linesEndRef = useRef<HTMLDivElement | null>(null);
  const firstLoadDoneRef = useRef(false);

  const fetchLines = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (level !== 'all') params.set('level', level);
      const sinceIso = sinceToIso(since);
      if (sinceIso) params.set('since', sinceIso);
      if (search.trim()) params.set('search', search.trim());
      params.set('limit', String(MAX_LINES));

      const data = await api<LogsResponse>(`/inboxes/${inboxId}/logs?${params.toString()}`);
      setFileFound(data.fileFound);
      setLines(data.lines);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.body : err instanceof Error ? err.message : 'Failed to load logs';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [api, inboxId, level, search, since]);

  // Initial load + reload whenever a filter changes.
  useEffect(() => {
    // `fetchLines` sets its own loading flag inside its body. We flip
    // the ref so the follow-mode interval knows we're past first-load.
    firstLoadDoneRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchLines();
  }, [fetchLines]);

  // Follow-mode polling.
  useEffect(() => {
    if (followTimerRef.current) {
      clearInterval(followTimerRef.current);
      followTimerRef.current = null;
    }
    if (follow && firstLoadDoneRef.current) {
      followTimerRef.current = setInterval(() => {
        void fetchLines();
      }, FOLLOW_INTERVAL_MS);
    }
    return () => {
      if (followTimerRef.current) {
        clearInterval(followTimerRef.current);
        followTimerRef.current = null;
      }
    };
  }, [follow, fetchLines]);

  // Auto-scroll to bottom when new lines arrive (only if we're
  // already near the bottom — don't yank the user's view around).
  const lastLineCount = useRef(0);
  useEffect(() => {
    if (lines.length > lastLineCount.current) {
      linesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    lastLineCount.current = lines.length;
  }, [lines.length]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Level"
          value={level}
          onChange={(v) => setLevel(v as LevelFilter)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'debug', label: 'Debug' },
            { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warn' },
            { value: 'error', label: 'Error' },
          ]}
        />
        <FilterSelect
          label="Time"
          value={since}
          onChange={(v) => setSince(v as SinceFilter)}
          options={[
            { value: '15m', label: 'Last 15 min' },
            { value: '1h', label: 'Last 1 hour' },
            { value: '6h', label: 'Last 6 hours' },
            { value: '24h', label: 'Last 24 hours' },
            { value: 'all', label: 'All' },
          ]}
        />
        <label className="inline-flex flex-1 items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs">
          <span className="text-slate-500">Search:</span>
          <input
            type="text"
            placeholder="free-text grep across all fields"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-slate-700 placeholder:text-slate-400 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => setFollow((f) => !f)}
          aria-pressed={follow}
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            follow ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
          }`}
        >
          <PulseDot state={follow ? 'live' : 'idle'} size="xs" label={follow ? 'Following' : 'Paused'} />
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>

      {!fileFound ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          Logs are only available in development — the structured NDJSON log file isn&rsquo;t written in production.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>
      ) : null}

      <div className="max-h-[640px] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200 shadow-inner">
        {loading && lines.length === 0 ? (
          <p className="text-slate-500">Loading logs…</p>
        ) : lines.length === 0 ? (
          <p className="text-slate-500">No log entries found for this inbox. Logs appear here once warmup activity starts.</p>
        ) : (
          lines.map((line, idx) => <LogLineRow key={`${line.time}-${idx}`} line={line} />)
        )}
        <div ref={linesEndRef} />
      </div>

      <p className="text-xs text-slate-500">
        Showing {lines.length} of the most recent matching lines
        {follow ? ` · updating every ${FOLLOW_INTERVAL_MS / 1000}s` : ''}.
      </p>
    </section>
  );
}

function sinceToIso(since: SinceFilter): string | null {
  if (since === 'all') return null;
  const minutes = since === '15m' ? 15 : since === '1h' ? 60 : since === '6h' ? 360 : 24 * 60;
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

interface FilterSelectProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}

function FilterSelect<T extends string>({ label, value, onChange, options }: FilterSelectProps<T>) {
  return (
    <label className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs">
      <span className="text-slate-500">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-transparent text-slate-700 focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  trace: 'text-slate-500',
  debug: 'text-sky-400',
  info: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-rose-400',
  fatal: 'text-fuchsia-400',
};

function LogLineRow({ line }: { line: LogLine }) {
  const colorClass = LEVEL_COLOR[line.levelName] ?? 'text-slate-300';
  const fields: string[] = [];
  for (const [key, val] of Object.entries(line)) {
    if (['level', 'levelName', 'time', 'context', 'msg', 'pid', 'hostname'].includes(key)) continue;
    if (val === undefined || val === null) continue;
    fields.push(`${key}=${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
  }

  return (
    <div className="whitespace-pre-wrap break-words">
      <span className={`mr-2 inline-block w-12 font-semibold ${colorClass}`}>[{line.levelName.toUpperCase()}]</span>
      <span className="mr-2 text-slate-500">[{formatTimeShort(line.time)}]</span>
      {line.context ? <span className="mr-2 text-slate-400">[{line.context}]</span> : null}
      <span className="text-slate-200">{line.msg}</span>
      {fields.length > 0 ? <span className="ml-2 text-slate-500">{`{${fields.join(' ')}}`}</span> : null}
    </div>
  );
}

function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour12: false });
}