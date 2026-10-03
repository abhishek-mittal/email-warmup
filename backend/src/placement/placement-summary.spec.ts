import { summarize } from './placement-test.processor';

const results = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([outcome, n]) => Array.from({ length: n }, () => ({ outcome })));

describe('summarize (placement result from per-seed outcomes)', () => {
  it('complete: every seed observed, percentages over all of them', () => {
    const s = summarize(results({ primary: 6, promotions: 2, spam: 1, not_found: 1 }));
    expect(s).toMatchObject({
      status: 'complete',
      seedCount: 10,
      observedCount: 10,
      errorCount: 0,
      primaryPct: 60,
      promotionsPct: 20,
      spamPct: 10,
      missingCount: 1,
      placementScore: 70, // (6 + 0.5*2) / 10
    });
  });

  it('partial: unobservable seeds are excluded from the denominator, not counted as spam or missing', () => {
    const s = summarize(results({ primary: 4, spam: 1, auth_error: 3, timeout: 2 }));
    expect(s).toMatchObject({
      status: 'partial',
      seedCount: 10,
      observedCount: 5,
      errorCount: 5,
      primaryPct: 80,
      spamPct: 20,
      missingCount: 0,
      placementScore: 80,
    });
  });

  it('a seed where the message was really not found counts against the sender', () => {
    const s = summarize(results({ primary: 2, not_found: 2 }));
    expect(s).toMatchObject({
      status: 'complete',
      observedCount: 4,
      primaryPct: 50,
      placementScore: 50,
    });
  });

  it.each([
    ['every seed failed to sign in', { auth_error: 10 }],
    ['every seed timed out', { timeout: 5 }],
    ['the sending server rejected every seed', { smtp_rejected: 4 }],
    ['only two seeds could be checked', { primary: 2, error: 8 }],
    ['seeds were removed', { seed_unavailable: 3 }],
  ])('failed, with no percentages, when %s', (_name, counts) => {
    const s = summarize(results(counts));
    expect(s.status).toBe('failed');
    expect(s.primaryPct).toBeNull();
    expect(s.spamPct).toBeNull();
    expect(s.placementScore).toBeNull();
    expect(s.failureReason).toContain('too few');
  });

  it('an empty test is failed, not a zero score', () => {
    expect(summarize([])).toMatchObject({ status: 'failed', placementScore: null, seedCount: 0 });
  });

  it('other inbox categories are delivered mail: half credit, never spam', () => {
    const s = summarize(results({ other_inbox: 4 }));
    expect(s).toMatchObject({ status: 'complete', spamPct: 0, primaryPct: 0, placementScore: 50 });
  });

  it('a still-pending row is not an observation', () => {
    const s = summarize(results({ primary: 3, pending: 1 }));
    expect(s).toMatchObject({ status: 'partial', observedCount: 3, errorCount: 1 });
  });
});
