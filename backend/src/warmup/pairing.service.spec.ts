import { PairingService } from './pairing.service';

/**
 * Unit coverage for the aggregation logic of `hasEligiblePartners` — the new
 * code added for the warmup start gate. The underlying `privateCandidates` /
 * `sharedCandidates` queries are stubbed here (their SQL is exercised by the
 * scheduler integration suite); these tests pin "at least one candidate with
 * spare capacity → eligible".
 */
describe('PairingService.hasEligiblePartners', () => {
  let service: PairingService;
  const sender = { id: 's', userId: 'u', email: 's@a.com', poolConsentAt: null } as never;

  const stub = (priv: unknown[], shared: unknown[]) => {
    jest.spyOn(service as never as { privateCandidates: unknown }, 'privateCandidates' as never)
      .mockResolvedValue(priv as never);
    jest.spyOn(service as never as { sharedCandidates: unknown }, 'sharedCandidates' as never)
      .mockResolvedValue(shared as never);
  };

  beforeEach(() => {
    service = new PairingService();
  });

  it('false when there are no private and no shared candidates', async () => {
    stub([], []);
    expect(await service.hasEligiblePartners(sender)).toBe(false);
  });

  it('true when a private candidate has spare capacity', async () => {
    stub([{ capacity: 5, score: 0, partner: {} }], []);
    expect(await service.hasEligiblePartners(sender)).toBe(true);
  });

  it('true when only a shared candidate has spare capacity', async () => {
    stub([], [{ capacity: 2, score: 0, partner: {} }]);
    expect(await service.hasEligiblePartners(sender)).toBe(true);
  });

  it('false when candidates exist but all have zero/negative capacity', async () => {
    stub([{ capacity: 0, score: 0, partner: {} }], [{ capacity: -1, score: 0, partner: {} }]);
    expect(await service.hasEligiblePartners(sender)).toBe(false);
  });
});
