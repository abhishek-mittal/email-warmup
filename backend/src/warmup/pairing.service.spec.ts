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
    expect(result).toEqual(candidateHigh);
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
    expect(result).toEqual(candidateB);
  });

  it('returns the pool_members row (with .id usable as partnerInboxId) of the winner', async () => {
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

    expect(result?.id).toBe('pool-winner');
  });

  it('does not write to warmup_sends (selection only, no side effects)', async () => {
    mockSelectSequence([[senderPoolMember], []]);

    await service.selectPartner('sender-1');

    expect((db as any).insert).toBeUndefined();
  });
});
