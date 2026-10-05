import Link from 'next/link';
import { inboxStatusColor, scoreColor } from '@/lib/plan-config';
import type { InboxListItem } from '@/app/(dashboard)/_lib/data';

const PROVIDER_LABEL: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook' };

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  error: 'bg-rose-500',
};

const TREND: Record<string, { glyph: string; cls: string; label: string }> = {
  up: { glyph: '↑', cls: 'text-emerald-600', label: 'improving' },
  down: { glyph: '↓', cls: 'text-rose-600', label: 'declining' },
  stable: { glyph: '→', cls: 'text-stone-400', label: 'steady' },
};

/** One inbox as a whole-row link: who it is, how it is doing, where it is in the ramp. */
export function InboxRow({ inbox }: { inbox: InboxListItem }) {
  const status = inboxStatusColor(inbox.status);
  const score = inbox.score;
  const colors = score != null ? scoreColor(score) : null;
  const trend = inbox.trend ? TREND[inbox.trend] : null;

  return (
    <li>
      <Link
        href={`/inboxes/${inbox.id}`}
        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-50 sm:gap-4 sm:px-5"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-600"
          aria-hidden
        >
          {inbox.email.slice(0, 2).toUpperCase()}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-stone-900">{inbox.email}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
            <span>{PROVIDER_LABEL[inbox.provider] ?? 'Custom SMTP'}</span>
            {inbox.warmupDay != null ? (
              <>
                <span aria-hidden>·</span>
                <span>Day {inbox.warmupDay}</span>
              </>
            ) : null}
          </span>
        </span>

        <span className="hidden items-center gap-1.5 text-xs font-medium text-stone-700 sm:flex">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[inbox.status] ?? 'bg-stone-300'}`} aria-hidden />
          {status.label}
        </span>

        <span className="w-14 text-right">
          {colors ? (
            <span className="inline-flex items-baseline gap-1">
              <span className={`text-lg font-semibold tabular-nums ${colors.text}`}>{score}</span>
              {trend ? (
                <span className={`text-xs ${trend.cls}`} role="img" aria-label={trend.label}>
                  {trend.glyph}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-stone-400">No score</span>
          )}
        </span>

        <svg
          viewBox="0 0 24 24"
          className="hidden h-4 w-4 text-stone-300 transition-colors group-hover:text-stone-500 sm:block"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </Link>
    </li>
  );
}
