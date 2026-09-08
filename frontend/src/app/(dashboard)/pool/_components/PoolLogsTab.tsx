'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, ApiError } from '@/lib/api';
import { PulseDot } from '@/components/PulseDot';
import type { PoolLogLine, PoolLogsResponse } from '@/lib/pool-activity-types';

interface Props {
  poolInboxId: string;
}

type LevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';
type SinceFilter = '15m' | '1h' | '6h' | '24h' | 'all';

const FOLLOW_INTERVAL_MS = 5000;
const MAX_LINES = 200;

/**
 * Logs viewer for a pool inbox. Mirrors the inbox-dashboard Logs tab
 * (T027) but fetches from `/pool-inboxes/:id/logs` and renders the same
 * NDJSON-stream shape.
 */
export function PoolLogsTab({ poolInboxId }: Props) {
  const api = useApi();
  const [level, setLevel] = useState<LevelFilter>('all');
  const [since, setSince] = useState<SinceFilter>('1h');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);

  const [lines, setLines] = useState<PoolLogLine[]>([]);
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

      const data = await api<PoolLogsResponse>(
        `/pool-inboxes/${poolInboxId}/logs?${params.toString()}`,
      );
      setFileFound(data.fileFound);
      setLines(data.lines);
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? err.body
          : err instanceof Error
            ? err.message
            : 'Failed to load logs';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [api, poolInboxId, level, search, since]);

  useEffect(() => {
    firstLoadDoneRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchLines();
  }, [fetchLines]);

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
            follow
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
          }`}
        >
          <PulseDot state={follow ? 'live' : 'idle'} size="xs" label={follow ? 'Following' : 'Paused'} />
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>

      {!fileFound ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          Logs are only available in development — the structured NDJSON log file isn&rsquo;t
          written in production.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="max-h-[640px] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200 shadow-inner">
        {loading && lines.length === 0 ? (
          <p className="text-slate-500">Loading logs…</p>
        ) : lines.length === 0 ? (
          <p className="text-slate-500">
            No log entries found for this pool inbox. Logs appear here once warmup activity
            starts.
          </p>
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
  const minutes =
    since === '15m' ? 15 : since === '1h' ? 60 : since === '6h' ? 360 : 24 * 60;
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

interface FilterSelectProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: FilterSelectProps<T>) {
  return (
    <label className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs">
      <span className="text-slate-500">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-transparent text-slate-700 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  info: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-rose-400',
  debug: 'text-slate-400',
  trace: 'text-slate-500',
};

function LogLineRow({ line }: { line: PoolLogLine }) {
  const ts = new Date(line.time);
  const timeStr = isNaN(ts.getTime()) ? line.time : ts.toISOString().slice(11, 19);
  const levelColor = LEVEL_COLOR[line.levelName] ?? 'text-slate-300';
  return (
    <div className="flex gap-2">
      <span className="text-slate-500">{timeStr}</span>
      <span className={`uppercase ${levelColor}`}>{line.levelName.padEnd(5)}</span>
      <span className="text-slate-300">{line.msg}</span>
    </div>
  );
}