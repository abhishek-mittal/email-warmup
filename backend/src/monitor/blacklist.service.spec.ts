import { Test, TestingModule } from '@nestjs/testing';
import * as dns from 'dns';
import { BlacklistService } from './blacklist.service';
import { RBL_LIST } from './rbl-list';

describe('BlacklistService', () => {
  let service: BlacklistService;
  let resolve4: jest.Mock;

  beforeEach(async () => {
    resolve4 = jest.fn();
    jest.spyOn(dns.promises, 'resolve4').mockImplementation(resolve4 as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [BlacklistService],
    }).compile();

    service = module.get<BlacklistService>(BlacklistService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkDomain', () => {
    it('queries all 8 RBLs in RBL_LIST against {domain}.{rblZone}', async () => {
      resolve4.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));

      await service.checkDomain('baddomain.com');

      expect(resolve4).toHaveBeenCalledTimes(RBL_LIST.length);
      for (const zone of RBL_LIST) {
        expect(resolve4).toHaveBeenCalledWith(`baddomain.com.${zone}`);
      }
    });

    it('marks an RBL as listed when the A record starts with 127.', async () => {
      resolve4.mockResolvedValue(['127.0.0.2']);

      const result = await service.checkDomain('baddomain.com');

      expect(result.isClean).toBe(false);
      expect(result.listed).toEqual(RBL_LIST);
      expect(result.listedCount).toBe(RBL_LIST.length);
      for (const zone of RBL_LIST) {
        expect(result.rblResults[zone]).toBe('listed');
      }
    });

    it('marks an RBL as clean on NXDOMAIN-equivalent errors (ENOTFOUND/ENODATA)', async () => {
      resolve4.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));

      const result = await service.checkDomain('cleandomain.com');

      expect(result.isClean).toBe(true);
      expect(result.listed).toEqual([]);
      expect(result.listedCount).toBe(0);
      for (const zone of RBL_LIST) {
        expect(result.rblResults[zone]).toBe('clean');
      }
    });

    it('treats ENODATA the same as ENOTFOUND (clean)', async () => {
      resolve4.mockRejectedValue(Object.assign(new Error('no data'), { code: 'ENODATA' }));

      const result = await service.checkDomain('cleandomain.com');

      expect(result.isClean).toBe(true);
      expect(result.rblResults[RBL_LIST[0]]).toBe('clean');
    });

    it("marks an RBL as 'unknown' (not listed, not clean) on a non-NXDOMAIN error, and does not let it affect isClean", async () => {
      resolve4.mockRejectedValue(Object.assign(new Error('server failure'), { code: 'SERVFAIL' }));

      const result = await service.checkDomain('flakydomain.com');

      expect(result.isClean).toBe(true);
      expect(result.listed).toEqual([]);
      expect(result.listedCount).toBe(0);
      for (const zone of RBL_LIST) {
        expect(result.rblResults[zone]).toBe('unknown');
      }
    });

    it("marks an RBL as 'unknown' when it exceeds the 5s timeout, without blocking the other RBLs", async () => {
      jest.useFakeTimers();
      resolve4.mockImplementation((query: string) => {
        if (query.includes(RBL_LIST[0])) {
          // Never resolves — simulates a hung RBL lookup.
          return new Promise(() => {});
        }
        return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
      });

      const resultPromise = service.checkDomain('slowdomain.com');
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result.rblResults[RBL_LIST[0]]).toBe('unknown');
      for (const zone of RBL_LIST.slice(1)) {
        expect(result.rblResults[zone]).toBe('clean');
      }
      expect(result.isClean).toBe(true);

      jest.useRealTimers();
    });

    it('mixes listed, clean, and unknown results independently per RBL', async () => {
      resolve4.mockImplementation((query: string) => {
        if (query.includes('zen.spamhaus.org')) {
          return Promise.resolve(['127.0.0.4']);
        }
        if (query.includes('dbl.spamhaus.org')) {
          return Promise.reject(Object.assign(new Error('servfail'), { code: 'SERVFAIL' }));
        }
        return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
      });

      const result = await service.checkDomain('mixed.com');

      expect(result.rblResults['zen.spamhaus.org']).toBe('listed');
      expect(result.rblResults['dbl.spamhaus.org']).toBe('unknown');
      expect(result.rblResults['bl.spamcop.net']).toBe('clean');
      expect(result.listed).toEqual(['zen.spamhaus.org']);
      expect(result.listedCount).toBe(1);
      expect(result.isClean).toBe(false);
    });
  });
});
