import { Test, TestingModule } from '@nestjs/testing';
import { SeedListService } from './seed-list.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('SeedListService', () => {
  let service: SeedListService;

  // The query is `and(eq(active, true), eq(provider, X))` — drizzle's `eq`
  // helper objects aren't easily introspectable here, so instead we rely on
  // call order: getSeedAddresses queries gmail, outlook, yahoo in that fixed
  // order (see `callOrder` below).
  function mockSelectByProvider(rowsByProvider: Record<string, any[]>) {
    (db.select as jest.Mock).mockImplementation(() => {
      const chain: any = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockImplementation(() => {
          const provider = callOrder.shift();
          return Promise.resolve(rowsByProvider[provider!] ?? []);
        }),
      };
      return chain;
    });
  }

  // Fixed call order used by getSeedAddresses (gmail, outlook, yahoo).
  let callOrder: string[];

  beforeEach(async () => {
    jest.clearAllMocks();
    callOrder = ['gmail', 'outlook', 'yahoo'];

    const module: TestingModule = await Test.createTestingModule({
      providers: [SeedListService],
    }).compile();
    service = module.get<SeedListService>(SeedListService);
  });

  it('returns 10 seeds for a quick test (5 gmail, 3 outlook, 2 yahoo) when enough rows exist', async () => {
    mockSelectByProvider({
      gmail: Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, provider: 'gmail' })),
      outlook: Array.from({ length: 3 }, (_, i) => ({ id: `o${i}`, provider: 'outlook' })),
      yahoo: Array.from({ length: 2 }, (_, i) => ({ id: `y${i}`, provider: 'yahoo' })),
    });

    const result = await service.getSeedAddresses('quick');

    expect(result).toHaveLength(10);
    expect(result.filter((r) => r.provider === 'gmail')).toHaveLength(5);
    expect(result.filter((r) => r.provider === 'outlook')).toHaveLength(3);
    expect(result.filter((r) => r.provider === 'yahoo')).toHaveLength(2);
  });

  it('returns 35 seeds for a full test (20 gmail, 10 outlook, 5 yahoo) when enough rows exist', async () => {
    mockSelectByProvider({
      gmail: Array.from({ length: 20 }, (_, i) => ({ id: `g${i}`, provider: 'gmail' })),
      outlook: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, provider: 'outlook' })),
      yahoo: Array.from({ length: 5 }, (_, i) => ({ id: `y${i}`, provider: 'yahoo' })),
    });

    const result = await service.getSeedAddresses('full');

    expect(result).toHaveLength(35);
  });

  it('returns however many rows exist when the table has fewer than the target count, without erroring or padding', async () => {
    mockSelectByProvider({
      gmail: [],
      outlook: [],
      yahoo: [],
    });

    const result = await service.getSeedAddresses('quick');

    expect(result).toEqual([]);
  });

  it('returns a partial result when only some providers have rows', async () => {
    mockSelectByProvider({
      gmail: [{ id: 'g0', provider: 'gmail' }],
      outlook: [],
      yahoo: [],
    });

    const result = await service.getSeedAddresses('quick');

    expect(result).toEqual([{ id: 'g0', provider: 'gmail' }]);
  });
});
