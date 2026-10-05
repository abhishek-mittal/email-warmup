/**
 * Picks send times for one inbox's day (MR-03).
 *
 * Guarantees, for any random source:
 *  - every slot lies inside [startMs, endMs];
 *  - consecutive slots are at least `minSpacingMs` apart;
 *  - no slot is in the past relative to `startMs` (callers pass "now" as the
 *    start when scheduling late, so a late start never produces a burst);
 *  - the count is capped to what the window can hold at that spacing.
 *
 * Times are drawn at random across the window rather than laid on a grid, so
 * no send ever fires at a predictable instant.
 */
export function planSlots(
  count: number,
  startMs: number,
  endMs: number,
  minSpacingMs: number,
  rng: () => number = Math.random,
): number[] {
  if (count <= 0 || endMs < startMs) return [];

  const span = endMs - startMs;
  const capacity = Math.floor(span / minSpacingMs) + 1;
  const n = Math.min(count, capacity);

  // Classic "n points with a minimum gap": draw n points in the window
  // shrunk by the mandatory gaps, sort, then re-insert the gaps.
  const slack = span - (n - 1) * minSpacingMs;
  const offsets = Array.from({ length: n }, () => clamp01(rng()) * slack).sort((a, b) => a - b);
  return offsets.map((offset, i) => Math.round(startMs + offset + i * minSpacingMs));
}

/** How many sends fit in the window at the minimum spacing. */
export function windowCapacity(startMs: number, endMs: number, minSpacingMs: number): number {
  if (endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / minSpacingMs) + 1;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
