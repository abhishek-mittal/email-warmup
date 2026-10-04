export type StatTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface Stat {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: StatTone;
}

const VALUE_TONE: Record<StatTone, string> = {
  neutral: 'text-stone-900',
  good: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-rose-700',
};

/** A row of summary tiles: label, big number, one line of context. */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <dl
      className={`grid grid-cols-2 overflow-hidden rounded-xl border border-stone-200 bg-white ${
        stats.length >= 4 ? 'lg:grid-cols-4' : ''
      }`}
    >
      {stats.map((stat, i) => (
        <div
          key={stat.label}
          className={`px-4 py-3.5 sm:px-5 ${i > 0 ? 'border-l border-stone-200' : ''} ${
            i >= 2 ? 'border-t border-stone-200 lg:border-t-0' : ''
          } ${i === 2 ? 'border-l-0 lg:border-l' : ''}`}
        >
          <dt className="eyebrow">{stat.label}</dt>
          <dd className={`mt-1.5 text-3xl font-semibold leading-none tabular-nums ${VALUE_TONE[stat.tone ?? 'neutral']}`}>
            {stat.value}
          </dd>
          {stat.hint ? <p className="mt-1.5 text-xs text-stone-500">{stat.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}
