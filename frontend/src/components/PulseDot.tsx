/**
 * Small animated status dot used everywhere the UI is doing something
 * live — polling, waiting on a job, syncing data, or processing a
 * request. Companion to the `usePolling` hook in
 * `frontend/src/lib/use-polling.ts`.
 *
 * Four states map to four visual treatments:
 *
 *   | state   | color         | animates | meaning                                |
 *   |---------|---------------|----------|----------------------------------------|
 *   | live    | emerald-500   | yes      | data is fresh and updating on its own |
 *   | busy    | sky-500       | yes      | a request is in flight, please wait    |
 *   | error   | rose-500      | no       | the last poll/request failed           |
 *   | idle    | stone-400     | no       | component is mounted but quiet        |
 *
 * The `live` and `busy` states share the same animation (Tailwind's
 * `animate-ping` — an expanding ring fading outward) so the visual
 * language stays consistent; only the color and the semantic label
 * differ. `error` and `idle` are static so the user can clearly see
 * "nothing's happening right now" at a glance.
 *
 * The component is server-component-safe — it has no hooks, no state,
 * no event handlers. Wrap it in a client component if you need a
 * dynamic state, or use the `usePolling` hook in
 * `frontend/src/lib/use-polling.ts` for the typical
 * "poll-until-done" pattern.
 *
 * Accessibility: renders a `role="status"` span with an `aria-label`
 * so screen readers announce the state change. The optional `label`
 * prop overrides the default state name (e.g. "Refreshing analysis"
 * instead of "busy").
 */
export type PulseState = 'live' | 'busy' | 'error' | 'idle';

const STYLES: Record<PulseState, { dot: string; ring: string; pulse: boolean }> = {
  live: { dot: 'bg-emerald-500', ring: 'bg-emerald-500/40', pulse: true },
  busy: { dot: 'bg-sky-500', ring: 'bg-sky-500/40', pulse: true },
  error: { dot: 'bg-rose-500', ring: 'bg-rose-500/40', pulse: false },
  idle: { dot: 'bg-stone-400', ring: 'bg-stone-400/40', pulse: false },
};

interface Props {
  state: PulseState;
  /** Optional human-readable label; falls back to the state name. Shown as both
   *  `aria-label` and `title` so the dot is screen-reader-friendly and has a
   *  hover tooltip explaining what it represents. */
  label?: string;
  /** Tailwind size override for the dot — defaults to `h-2 w-2` (8px). */
  size?: 'xs' | 'sm' | 'md';
}

const SIZE: Record<NonNullable<Props['size']>, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
};

export function PulseDot({ state, label, size = 'sm' }: Props) {
  const s = STYLES[state];
  const dim = SIZE[size];
  return (
    <span
      className="relative inline-flex"
      role="status"
      aria-label={label ?? state}
      title={label ?? state}
    >
      {s.pulse ? (
        <span
          aria-hidden="true"
          className={`absolute inset-0 inline-flex rounded-full ${s.ring} animate-ping`}
        />
      ) : null}
      <span className={`relative inline-flex rounded-full ${dim} ${s.dot}`} />
    </span>
  );
}
