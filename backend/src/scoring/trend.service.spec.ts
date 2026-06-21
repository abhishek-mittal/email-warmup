import { Test, TestingModule } from '@nestjs/testing';
import { TrendService } from './trend.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('TrendService', () => {
  let service: TrendService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrendService],
    }).compile();
    service = module.get<TrendService>(TrendService);
  });

  function mockHistory(rows: { score: number }[]) {
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    (db.select as jest.Mock).mockReturnValue(chain);
    return chain;
  }

  it('returns stable when there is no history at all', async () => {
    mockHistory([]);
    expect(await service.computeTrend('inbox-1')).toBe('stable');
  });

  it('returns stable when history.length is 1', async () => {
    mockHistory([{ score: 80 }]);
    expect(await service.computeTrend('inbox-1')).toBe('stable');
  });

  it('returns stable when history.length is 2', async () => {
    mockHistory([{ score: 80 }, { score: 78 }]);
    expect(await service.computeTrend('inbox-1')).toBe('stable');
  });

  it('returns stable when history.length is 3 (the skill file bug case)', async () => {
    // With the buggy skill formula, slice(3) on a 3-length array would be [],
    // and Math.max(1, 0) would fabricate avgPrev2 = 0, always reading as "up".
    // The fix requires >= 4 rows before attempting up/down.
    mockHistory([{ score: 80 }, { score: 78 }, { score: 76 }]);
    expect(await service.computeTrend('inbox-1')).toBe('stable');
  });

  it('returns up when avgLast3 > avgPrev2 + 3, with exactly 4 rows of history', async () => {
    // last3 = [90, 88, 86] avg=88; rest = [70] avg=70. 88 > 70+3 -> up
    mockHistory([{ score: 90 }, { score: 88 }, { score: 86 }, { score: 70 }]);
    expect(await service.computeTrend('inbox-1')).toBe('up');
  });

  it('returns down when avgLast3 < avgPrev2 - 3, with 5 rows of history', async () => {
    // last3 = [60, 58, 56] avg=58; rest = [80, 82] avg=81. 58 < 81-3 -> down
    mockHistory([{ score: 60 }, { score: 58 }, { score: 56 }, { score: 80 }, { score: 82 }]);
    expect(await service.computeTrend('inbox-1')).toBe('down');
  });

  it('returns stable when the difference is within the +-3 band', async () => {
    // last3 = [80, 79, 81] avg=80; rest = [78, 80] avg=79. diff=1, within band.
    mockHistory([{ score: 80 }, { score: 79 }, { score: 81 }, { score: 78 }, { score: 80 }]);
    expect(await service.computeTrend('inbox-1')).toBe('stable');
  });

  it('queries ordered by recordedAt descending, limited to 5', async () => {
    const chain = mockHistory([{ score: 80 }, { score: 78 }, { score: 76 }, { score: 74 }]);
    await service.computeTrend('inbox-1');
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(5);
  });
});
