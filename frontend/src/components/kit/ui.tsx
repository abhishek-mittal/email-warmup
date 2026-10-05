'use client';

import { useId } from 'react';

/* ---------- buttons ---------- */
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-50';
export const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-50';
export const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50';
export const btnDanger =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-[13px] font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50';
export const inputCls =
  'h-9 w-full rounded-lg border border-stone-300 bg-white px-3 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100';

/* ---------- pill ---------- */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand';
const PILL: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  good: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  bad: 'bg-rose-50 text-rose-700',
  info: 'bg-sky-50 text-sky-700',
  brand: 'bg-brand-50 text-brand-700',
};
const DOT: Record<Tone, string> = {
  neutral: 'bg-stone-400',
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  info: 'bg-sky-500',
  brand: 'bg-brand-500',
};

export function Pill({ tone = 'neutral', dot, children }: { tone?: Tone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${PILL[tone]}`}>
      {dot ? <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Uppercase status text with a dot, the list-row status style. */
export function StatusText({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  const text: Record<Tone, string> = {
    neutral: 'text-stone-500', good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-rose-700', info: 'text-sky-700', brand: 'text-brand-700',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider ${text[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} aria-hidden />
      {children}
    </span>
  );
}

/* ---------- avatar ---------- */
const AVATAR_TINTS = ['bg-brand-100 text-brand-800', 'bg-sky-100 text-sky-800', 'bg-emerald-100 text-emerald-800', 'bg-violet-100 text-violet-800', 'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-800'];

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  const tint = AVATAR_TINTS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TINTS.length];
  const dim = size === 'sm' ? 'h-6 w-6 text-[10px]' : size === 'lg' ? 'h-10 w-10 text-sm' : 'h-8 w-8 text-xs';
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${dim} ${tint}`} aria-hidden>
      {initials || '?'}
    </span>
  );
}

/* ---------- toggle ---------- */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-brand-600' : 'bg-stone-300'
      }`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

/* ---------- empty state ---------- */
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-400" aria-hidden>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7h18M5 7l1 12h12l1-12M9 7V4h6v3" />
        </svg>
      </span>
      <p className="text-sm font-medium text-stone-900">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-sm text-stone-500">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ---------- inputs ---------- */
export function SearchBox({ value, onChange, placeholder = 'Search…', className = '' }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{placeholder}</span>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputCls} pl-8`} />
    </label>
  );
}

export function SelectBox<T extends string>({ value, onChange, options, label, className = '' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`${inputCls} pr-8`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-stone-800">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-stone-500">{hint}</p> : null}
    </div>
  );
}

/* ---------- cards and settings rows ---------- */
export function Card({ title, description, actions, children, padded = true }: { title?: string; description?: string; actions?: React.ReactNode; children: React.ReactNode; padded?: boolean }) {
  return (
    <section className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b border-stone-100 px-4 py-3 sm:px-5">
          <div>
            {title ? <h2 className="text-sm font-semibold text-stone-900">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-stone-500">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? 'p-4 sm:p-5' : ''}>{children}</div>
    </section>
  );
}

/** One labelled setting: text on the left, control on the right. */
export function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:max-w-md">
        <p className="text-[13px] font-medium text-stone-900">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-stone-500">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-stone-100">{children}</div>;
}

/* ---------- progress ---------- */
export function ProgressBar({ value, max = 100, tone = 'brand', label }: { value: number; max?: number; tone?: 'brand' | 'good' | 'warn' | 'bad'; label: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const fill = { brand: 'bg-brand-500', good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500' }[tone];
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10.5px] text-stone-500">{children}</kbd>;
}
