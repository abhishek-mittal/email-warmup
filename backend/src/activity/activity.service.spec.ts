import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';
import { pinoLoggerStubsFor } from '../common/test-module';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('ActivityService', () => {
  let service: ActivityService;
  let queueService: { add: jest.Mock };

  // A query chain that resolves `rows` no matter which terminal method
  // the caller uses — `.then()`, `.limit(n)`, `.offset(n)` all return
  // the same rows. Mirrors the way ActivityService consumes the
  // Drizzle chain (it uses both intermediate-thenable and `.limit(n)`
  // terminator styles depending on the query).
  function mockSelectChain(rows: unknown[]): any {
    const chain: any = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
      offset: jest.fn().mockResolvedValue(rows),
      // Allow awaiting the chain directly (no .limit() / .offset()) — used
      // for queries like `.select().from().where()` returning a count().
      then: (resolve: any) => Promise.resolve(rows).then(resolve),
    };
    (db.select as jest.Mock).mockReturnValueOnce(chain);
    return chain;
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    queueService = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(NotFoundException, ActivityService),
        ActivityService,
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
  });

  describe('assertOwnership', () => {
    it('throws NotFound when the inbox does not exist', async () => {
      mockSelectChain([]);
      await expect(service.assertOwnership('missing', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when the inbox belongs to another user', async () => {
      mockSelectChain([{ id: 'abc', userId: 'someone-else' }]);
      await expect(service.assertOwnership('abc', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the inbox row when the caller owns it', async () => {
      mockSelectChain([{ id: 'abc', userId: 'user-1' }]);
      const inbox = await service.assertOwnership('abc', 'user-1');
      expect(inbox.id).toBe('abc');
    });
  });

  describe('runDnsCheck', () => {
    it('enqueues a dns-check job for an owned inbox', async () => {
      mockSelectChain([{ id: 'abc', userId: 'user-1' }]);
      await service.runDnsCheck('abc', 'user-1');
      expect(queueService.add).toHaveBeenCalledWith('dns-check', { inboxId: 'abc' });
    });

    it('refuses to enqueue when the inbox is not owned by the caller', async () => {
      mockSelectChain([{ id: 'abc', userId: 'someone-else' }]);
      await expect(service.runDnsCheck('abc', 'user-1')).rejects.toThrow(NotFoundException);
      expect(queueService.add).not.toHaveBeenCalled();
    });
  });

  describe('runBlacklistCheck', () => {
    it('enqueues a blacklist-check job for an owned inbox', async () => {
      mockSelectChain([{ id: 'abc', userId: 'user-1' }]);
      await service.runBlacklistCheck('abc', 'user-1');
      expect(queueService.add).toHaveBeenCalledWith('blacklist-check', { inboxId: 'abc' });
    });

    it('refuses to enqueue when the inbox is not owned by the caller', async () => {
      mockSelectChain([{ id: 'abc', userId: 'someone-else' }]);
      await expect(service.runBlacklistCheck('abc', 'user-1')).rejects.toThrow(NotFoundException);
      expect(queueService.add).not.toHaveBeenCalled();
    });
  });
});
