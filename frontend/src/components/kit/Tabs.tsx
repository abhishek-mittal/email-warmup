'use client';

/** Underline tab bar, the detail-pane pattern: active tab is bold with a brand underline. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-1 overflow-x-auto border-b border-stone-200">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`relative h-10 shrink-0 px-2.5 text-[13px] transition-colors ${active ? 'font-medium text-stone-900' : 'text-stone-500 hover:text-stone-800'}`}
          >
            <span className="inline-flex items-center gap-1.5">
              {tab.label}
              {tab.count != null ? <span className="font-mono text-[11px] tabular-nums text-stone-400">{tab.count}</span> : null}
            </span>
            {active ? <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-brand-600" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Pill-style filter chips (All / Active / Paused…). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${o.id === value ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
        >
          {o.label}
          {o.count != null ? <span className="ml-1 font-mono text-[11px] opacity-60">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
