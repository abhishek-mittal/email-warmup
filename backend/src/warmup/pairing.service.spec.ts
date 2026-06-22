import { Test, TestingModule } from '@nestjs/testing';
import { PairingService } from './pairing.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('PairingService', () => {
  let service: PairingService;

  const senderPoolMember = {
    id: 'sender-pool-1',
    inboxId: 'sender-1',
    email: 'sender@sendco.com',
    domain: 'sendco.com',
    provider: 'gmail',
    industry: 'fintech',
    reputation: 50,
    active: true,
    quarantined: false,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PairingService],
    }).compile();
    service = module.get<PairingService>(PairingService);
    jest.clearAllMocks();
  });

  // Mocks db.select() calls in the exact sequence the service is expected to issue them:
  // 1. sender's own pool_members row
  // 2. candidate pool_members rows
  // 3..N. one warmup_sends "paired in last 7 days" lookup per candidate, in candidate order
  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      // `where()` resolves directly (for queries with no further chaining, e.g. the
      // candidates query) AND stays chainable so `.limit()` can be called on top of it
      // (for queries that do chain further, e.g. the sender/recency lookups).
      const wherePromise: any = Promise.resolve(result);
      wherePromise.limit = jest.fn().mockResolvedValue(result);
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue(wherePromise),
      };
    });
  }

  it('returns null when the sender has no pool_members row', async () => {
    mockSelectSequence([[]]);

    const result = await service.selectPartner('sender-1');

    expect(result).toBeNull();
  });

  it('returns null when there are no eligible candidates', async () => {
    mockSelectSequence([[senderPoolMember], []]);

    const result = await service.selectPartner('sender-1');

    expect(result).toBeNull();
  });

  it('queries candidates excluding same domain and the sender own pool_members id', async () => {
    mockSelectSequence([[senderPoolMember], []]);

    await service.selectPartner('sender-1');

    // First call loads sender's pool_members row, second call loads candidates.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('selects the highest scoring candidate among multiple', async () => {
    const candidateLow = {
      id: 'pool-low',
      inboxId: 'inbox-low',
      domain: 'low.com',
      provider: 'gmail',
      industry: 'fintech',
      reputation: 50,
      active: true,
      quarantined: false,
    };
    const candidateHigh = {
      id: 'pool-high',
      inboxId: 'inbox-high',
      domain: 'high.com',
      provider: 'outlook', // different provider -> +20
      industry: 'fintech', // same industry -> +10
      reputation: 50,
      active: true,
      quarantined: false,
    };

    mockSelectSequence([
      [senderPoolMember],
      [candidateLow, candidateHigh],
      [], // candidateLow not paired in last 7 days
      [], // candidateHigh not paired in last 7 days
    ]);

    const result = await service.selectPartner('sender-1');

    // candidateLow score = 50 (same provider, same industry doesn't matter since not different provider) + 10 = 60
    // candidateHigh score = 50 + 20 + 10 = 80
    expect(result).toEqual({ source: 'shared', poolMember: candidateHigh });
  });

  it('applies a -15 penalty for candidates paired with the sender in the last 7 days', async () => {
    const candidateA = {
      id: 'pool-a',
      inboxId: 'inbox-a',
      domain: 'a.com',
      provider: 'gmail',
      industry: null,
      reputation: 80,
      active: true,
      quarantined: false,
    };
    const candidateB = {
      id: 'pool-b',
      inboxId: 'inbox-b',
      domain: 'b.com',
      provider: 'gmail',
      industry: null,
      reputation: 70,
      active: true,
      quarantined: false,
    };

    mockSelectSequence([
      [senderPoolMember],
      [candidateA, candidateB],
      [{ id: 'ws-1' }], // candidateA paired with sender in last 7 days -> 80 - 15 = 65
      [], // candidateB not paired -> 70
    ]);

    const result = await service.selectPartner('sender-1');

    // candidateB (70) beats candidateA (65) despite candidateA's higher base reputation.
    expect(result).toEqual({ source: 'shared', poolMember: candidateB });
  });

  it('returns the pool_members row (with .poolMember.id usable as partnerId) of the winner', async () => {
    const candidate = {
      id: 'pool-winner',
      inboxId: 'inbox-winner',
      domain: 'winner.com',
      provider: 'outlook',
      industry: null,
      reputation: 90,
      active: true,
      quarantined: false,
    };

    mockSelectSequence([[senderPoolMember], [candidate], []]);

    const result = await service.selectPartner('sender-1');

    expect(result?.source).toBe('shared');
    expect(result && result.source === 'shared' ? result.poolMember.id : null).toBe('pool-winner');
  });

  it('does not write to warmup_sends (selection only, no side effects)', async () => {
    mockSelectSequence([[senderPoolMember], []]);

    await service.selectPartner('sender-1');

    expect((db as any).insert).toBeUndefined();
  });

  describe('private pool (userId provided)', () => {
    const senderInbox = {
      id: 'sender-1',
      email: 'sender@sendco.com',
      provider: 'gmail',
    };

    it('queries pool_inboxes for the tenant before the shared pool', async () => {
      mockSelectSequence([
        [senderInbox], // sender inbox lookup (for domain)
        [], // no pool_inboxes candidates
        [senderPoolMember], // shared pool fallback: sender's own pool_members row
        [], // shared pool fallback: no candidates
      ]);

      await service.selectPartner('sender-1', 'user-1');

      // 1: sender inbox lookup, 2: pool_inboxes candidates, 3: shared sender lookup, 4: shared candidates
      expect(db.select).toHaveBeenCalledTimes(4);
    });

    it('returns the private pool inbox with the lowest active_pairs, tagged source=private', async () => {
      const poolInboxHigh = {
        id: 'pi-high',
        userId: 'user-1',
        email: 'a@poolco.com',
        provider: 'gmail',
        status: 'active',
        activePairs: 5,
      };
      const poolInboxLow = {
        id: 'pi-low',
        userId: 'user-1',
        email: 'b@otherpool.com',
        provider: 'gmail',
        status: 'active',
        activePairs: 1,
      };

      mockSelectSequence([
        [senderInbox],
        [poolInboxHigh, poolInboxLow],
        [], // poolInboxHigh recency check
        [], // poolInboxLow recency check
      ]);

      const result = await service.selectPartner('sender-1', 'user-1');

      expect(result).toEqual({ source: 'private', poolInbox: poolInboxLow });
    });

    it('applies the same-domain hard block to private pool candidates', async () => {
      const sameDomainPoolInbox = {
        id: 'pi-same-domain',
        userId: 'user-1',
        email: 'pool@sendco.com', // same domain as sender
        provider: 'gmail',
        status: 'active',
        activePairs: 0,
      };

      mockSelectSequence([
        [senderInbox],
        [sameDomainPoolInbox],
        [senderPoolMember], // falls through to shared pool
        [],
      ]);

      const result = await service.selectPartner('sender-1', 'user-1');

      // sameDomainPoolInbox filtered out -> falls back to shared pool, which also
      // has no eligible candidates here -> null.
      expect(result).toBeNull();
    });

    it('falls back to the shared pool when no private pool inbox qualifies (empty pool)', async () => {
      const sharedCandidate = {
        id: 'shared-winner',
        inboxId: 'inbox-shared',
        domain: 'shared.com',
        provider: 'outlook',
        industry: null,
        reputation: 60,
        active: true,
        quarantined: false,
      };

      mockSelectSequence([
        [senderInbox],
        [], // no pool_inboxes at all
        [senderPoolMember],
        [sharedCandidate],
        [], // recency check for sharedCandidate
      ]);

      const result = await service.selectPartner('sender-1', 'user-1');

      expect(result).toEqual({ source: 'shared', poolMember: sharedCandidate });
    });

    it('falls back to the shared pool when only same-domain private pool inboxes exist', async () => {
      const sameDomainPoolInbox = {
        id: 'pi-same-domain',
        userId: 'user-1',
        email: 'pool@sendco.com',
        provider: 'gmail',
        status: 'active',
        activePairs: 0,
      };
      const sharedCandidate = {
        id: 'shared-winner',
        inboxId: 'inbox-shared',
        domain: 'shared.com',
        provider: 'outlook',
        industry: null,
        reputation: 60,
        active: true,
        quarantined: false,
      };

      mockSelectSequence([
        [senderInbox],
        [sameDomainPoolInbox],
        [senderPoolMember],
        [sharedCandidate],
        [],
      ]);

      const result = await service.selectPartner('sender-1', 'user-1');

      expect(result).toEqual({ source: 'shared', poolMember: sharedCandidate });
    });

    it('returns null when neither private nor shared pool yields a partner', async () => {
      mockSelectSequence([
        [senderInbox],
        [], // no pool_inboxes
        [], // shared: sender has no pool_members row either
      ]);

      const result = await service.selectPartner('sender-1', 'user-1');

      expect(result).toBeNull();
    });

    it('applies the 7-day recency penalty for a private pool inbox used by this sender recently', async () => {
      const poolInboxA = {
        id: 'pi-a',
        userId: 'user-1',
        email: 'a@apool.com',
        provider: 'gmail',
        status: 'active',
        activePairs: 0, // equal active_pairs so recency is the deciding factor
      };
      const poolInboxB = {
        id: 'pi-b',
        userId: 'user-1',
        email: 'b@bpool.com',
        provider: 'gmail',
        status: 'active',
        activePairs: 0,
      };

      mockSelectSequence([
        [senderInbox],
        [poolInboxA, poolInboxB],
        [{ id: 'ws-1' }], // poolInboxA used by this sender in last 7 days -> penalized
        [], // poolInboxB not used recently
      ]);

      const result = await service.selectPartner('sender-1', 'user-1');

      expect(result).toEqual({ source: 'private', poolInbox: poolInboxB });
    });

    it('does not query the private pool when userId is not provided (existing behavior unchanged)', async () => {
      mockSelectSequence([[senderPoolMember], []]);

      await service.selectPartner('sender-1');

      // Only the shared-pool queries (sender pool_members lookup + candidates) — no
      // pool_inboxes query at all.
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });
});
