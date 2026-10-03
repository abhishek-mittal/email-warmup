import { planSlots, windowCapacity } from './slot-planner';

const MIN = 60_000;
const SPACING = 8 * MIN;
const START = Date.UTC(2026, 9, 3, 8, 0, 0);
const END = Date.UTC(2026, 9, 3, 18, 0, 0);

function assertValid(slots: number[], start = START, end = END) {
  for (let i = 0; i < slots.length; i++) {
    expect(slots[i]).toBeGreaterThanOrEqual(start);
    expect(slots[i]).toBeLessThanOrEqual(end);
    if (i > 0) expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(SPACING);
  }
}

describe('planSlots', () => {
  it('returns nothing for a zero or negative count', () => {
    expect(planSlots(0, START, END, SPACING)).toEqual([]);
    expect(planSlots(-3, START, END, SPACING)).toEqual([]);
  });

  it('returns nothing when the window has already closed', () => {
    expect(planSlots(5, END + MIN, END, SPACING)).toEqual([]);
  });

  it.each([
    ['all-minimum jitter', () => 0],
    ['all-maximum jitter', () => 1],
    ['just under maximum', () => 0.999999],
  ])('keeps spacing and bounds under %s', (_name, rng) => {
    for (const count of [1, 2, 10, 50, 76]) {
      const slots = planSlots(count, START, END, SPACING, rng);
      expect(slots).toHaveLength(count);
      assertValid(slots);
    }
  });

  it('keeps spacing and bounds across many random draws', () => {
    for (let run = 0; run < 200; run++) {
      const count = 1 + Math.floor(Math.random() * 76);
      const slots = planSlots(count, START, END, SPACING);
      expect(slots).toHaveLength(count);
      assertValid(slots);
    }
  });

  it('caps the count to what the window can hold instead of extending or bursting', () => {
    // 10h / 8min = 75 gaps -> 76 sends.
    expect(windowCapacity(START, END, SPACING)).toBe(76);
    const slots = planSlots(150, START, END, SPACING);
    expect(slots).toHaveLength(76);
    assertValid(slots);
  });

  it('a late start only produces future slots, fewer of them', () => {
    const lateStart = Date.UTC(2026, 9, 3, 17, 30, 0);
    const slots = planSlots(40, lateStart, END, SPACING);
    expect(slots).toHaveLength(4); // 30min / 8min = 3 gaps -> 4 sends
    assertValid(slots, lateStart, END);
  });

  it('does not place sends at fixed instants', () => {
    const a = planSlots(5, START, END, SPACING);
    const b = planSlots(5, START, END, SPACING);
    expect(a).not.toEqual(b);
  });

  it('treats a misbehaving random source as in-range', () => {
    const slots = planSlots(5, START, END, SPACING, () => Number.NaN);
    expect(slots).toHaveLength(5);
    assertValid(slots);
    assertValid(planSlots(5, START, END, SPACING, () => 7));
  });
});
