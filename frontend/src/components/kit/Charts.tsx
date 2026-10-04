/** Small dependency-free SVG charts. Colours come from the brand and status palette. */

export interface Series {
  name: string;
  values: number[];
  color: string;
}

const W = 600;
const H = 180;
const PAD = { l: 34, r: 8, t: 8, b: 22 };

export function LineChart({ series, labels, ariaLabel, percent }: { series: Series[]; labels: string[]; ariaLabel: string; percent?: boolean }) {
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const top = percent ? Math.max(10, Math.ceil(max / 10) * 10) : Math.ceil(max / 10) * 10 || 10;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const ticks = [0, top / 2, top];
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#e7e5e4" strokeDasharray="3 3" />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#78716c">
              {percent ? `${t}%` : t}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % Math.ceil(labels.length / 6) === 0 ? (
            <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="#78716c">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
          />
        ))}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function BarChart({ data, ariaLabel, color = '#d94f0b' }: { data: Array<{ label: string; value: number }>; ariaLabel: string; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="m-0 list-none space-y-2 p-0" aria-label={ariaLabel}>
      {data.map((d) => (
        <li key={d.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate text-stone-600">{d.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-stone-100">
            <span className="block h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: color }} />
          </span>
          <span className="font-mono tabular-nums text-stone-700">{d.value.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stacked horizontal share bar with a legend, e.g. inbox / promotions / spam. */
export function ShareBar({ parts, ariaLabel }: { parts: Array<{ label: string; value: number; color: string }>; ariaLabel: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0) || 1;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-stone-100" role="img" aria-label={ariaLabel}>
        {parts.map((p) => (
          <span key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
        {parts.map((p) => (
          <li key={p.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} aria-hidden />
            {p.label} <span className="font-mono tabular-nums text-stone-900">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Sparkline({ values, color = '#d94f0b', ariaLabel }: { values: number[]; color?: string; ariaLabel: string }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" className="h-6 w-20" role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
