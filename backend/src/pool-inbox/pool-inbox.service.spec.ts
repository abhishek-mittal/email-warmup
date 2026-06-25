import { Test, TestingModule } from '@nestjs/testing';
import { PoolInboxService } from './pool-inbox.service';
import { QueueService } from '@/queue/queue.service';
import { db } from '@/db';
import { encrypt } from '@/common/crypto';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('@/db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('@/common/crypto', () => ({
  encrypt: jest.fn((v: string) => `enc(${v})`),
  decrypt: jest.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

describe('PoolInboxService', () => {
  let service: PoolInboxService;
  let queueService: { add: jest.Mock };

  function mockSelectExisting(existingEmails: string[]) {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(existingEmails.map((email) => ({ email }))),
    });
  }

  function mockInsertReturning(impl: (vals: any) => any) {
    (db.insert as jest.Mock).mockImplementation(() => ({
      values: jest.fn().mockImplementation((vals: any) => ({
        returning: jest.fn().mockImplementation(() => {
          const result = impl(vals);
          if (result instanceof Error) return Promise.reject(result);
          return Promise.resolve([result]);
        }),
      })),
    }));
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    (encrypt as jest.Mock).mockImplementation((v: string) => `enc(${v})`);
    queueService = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PoolInboxService,
        { provide: QueueService, useValue: queueService },
        ...pinoLoggerStubsFor(PoolInboxService, QueueService, db),
      ],
    }).compile();

    service = module.get<PoolInboxService>(PoolInboxService);
  });

  describe('batchUpload', () => {
    it('writes a gmail entry to pool_inboxes with encryptedCredentials shape {clientId, clientSecret, refreshToken} and enqueues inbox-analysis', async () => {
      mockSelectExisting([]);
      let counter = 0;
      mockInsertReturning((vals) => ({ ...vals, id: `pi-${++counter}` }));

      const result = await service.batchUpload('user-1', [
        {
          email: 'a@domain.com',
          provider: 'gmail',
          clientId: 'cid',
          clientSecret: 'csecret',
          refreshToken: 'rtoken',
        } as any,
      ]);

      expect(result.created).toBe(1);
      expect(result.failed).toEqual([]);

      const insertCall = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
      expect(insertCall).toMatchObject({
        userId: 'user-1',
        email: 'a@domain.com',
        provider: 'gmail',
        status: 'pending',
      });
      expect(insertCall.encryptedCredentials).toEqual({
        clientId: 'cid',
        clientSecret: 'enc(csecret)',
        refreshToken: 'enc(rtoken)',
      });

      expect(queueService.add).toHaveBeenCalledWith('inbox-analysis', {
        poolInboxId: 'pi-1',
        userId: 'user-1',
      });
    });

    it('writes a custom entry with encryptedCredentials shape {smtpHost, smtpPort, smtpUser, smtpPassword(enc), imapHost, imapPort, imapUser, imapPassword(enc)}', async () => {
      mockSelectExisting([]);
      mockInsertReturning((vals) => ({ ...vals, id: 'pi-1' }));

      const result = await service.batchUpload('user-1', [
        {
          email: 'c@domain.com',
          provider: 'custom',
          smtpHost: 'smtp.domain.com',
          smtpPort: 587,
          smtpUser: 'c@domain.com',
          smtpPassword: 'smtppw',
          imapHost: 'imap.domain.com',
          imapPort: 993,
          imapUser: 'c@domain.com',
          imapPassword: 'imappw',
        } as any,
      ]);

      expect(result.created).toBe(1);
      const insertCall = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
      expect(insertCall.encryptedCredentials).toEqual({
        smtpHost: 'smtp.domain.com',
        smtpPort: 587,
        smtpUser: 'c@domain.com',
        smtpPassword: 'enc(smtppw)',
        imapHost: 'imap.domain.com',
        imapPort: 993,
        imapUser: 'c@domain.com',
        imapPassword: 'enc(imappw)',
      });
    });

    it('processes every row independently — malformed row does not block valid rows', async () => {
      mockSelectExisting([]);
      let counter = 0;
      mockInsertReturning((vals) => ({ ...vals, id: `pi-${++counter}` }));

      const result = await service.batchUpload('user-1', [
        {
          email: 'good@domain.com',
          provider: 'gmail',
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
        } as any,
        { email: 'bad@domain.com', provider: 'gmail' } as any,
      ]);

      expect(result.created).toBe(1);
      expect(result.failed).toEqual([{ email: 'bad@domain.com', reason: expect.any(String) }]);
    });

    it('catches a Postgres unique-violation (23505) on duplicate email and surfaces it as failed[], not a 500', async () => {
      mockSelectExisting([]);
      mockInsertReturning(() => Object.assign(new Error('duplicate key value'), { code: '23505' }));

      const result = await service.batchUpload('user-1', [
        {
          email: 'dup@domain.com',
          provider: 'gmail',
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
        } as any,
      ]);

      expect(result.created).toBe(0);
      expect(result.failed).toEqual([
        { email: 'dup@domain.com', reason: expect.stringContaining('duplicate') },
      ]);
    });

    it('rejects duplicate emails within the same batch before hitting the DB', async () => {
      mockSelectExisting([]);
      let counter = 0;
      mockInsertReturning((vals) => ({ ...vals, id: `pi-${++counter}` }));

      const result = await service.batchUpload('user-1', [
        {
          email: 'dup@domain.com',
          provider: 'gmail',
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
        } as any,
        {
          email: 'dup@domain.com',
          provider: 'gmail',
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
        } as any,
      ]);

      expect(result.created).toBe(1);
      expect(result.failed).toEqual([
        { email: 'dup@domain.com', reason: expect.stringContaining('duplicate') },
      ]);
    });
  });

  describe('create (single add)', () => {
    it('inserts one pool inbox and enqueues inbox-analysis', async () => {
      mockInsertReturning((vals) => ({ ...vals, id: 'pi-1' }));

      const result = await service.create('user-1', {
        email: 'a@domain.com',
        provider: 'outlook',
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rtok',
      } as any);

      expect(result.id).toBe('pi-1');
      expect(queueService.add).toHaveBeenCalledWith('inbox-analysis', {
        poolInboxId: 'pi-1',
        userId: 'user-1',
      });
    });

    it('throws on a structurally malformed single entry', async () => {
      await expect(
        service.create('user-1', { email: 'a@domain.com', provider: 'gmail' } as any),
      ).rejects.toThrow();
    });

    it('throws a clear duplicate error (not a raw 23505) on unique violation', async () => {
      mockInsertReturning(() => Object.assign(new Error('duplicate key value'), { code: '23505' }));

      await expect(
        service.create('user-1', {
          email: 'dup@domain.com',
          provider: 'gmail',
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
        } as any),
      ).rejects.toThrow(/duplicate/i);
    });
  });

  describe('findByUser', () => {
    it('returns only pool inboxes belonging to the given user', async () => {
      const rows = [{ id: 'pi-1', userId: 'user-1' }];
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(rows),
      });

      const result = await service.findByUser('user-1');
      expect(result).toEqual(rows);
    });
  });

  describe('findById', () => {
    it('returns null when the pool inbox does not exist', async () => {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      const result = await service.findById('user-1', 'missing-id');
      expect(result).toBeNull();
    });

    it('returns null when the pool inbox belongs to another user', async () => {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ id: 'pi-1', userId: 'other-user' }]),
      });

      const result = await service.findById('user-1', 'pi-1');
      expect(result).toBeNull();
    });

    it('returns the row when owned by the requesting user', async () => {
      const row = { id: 'pi-1', userId: 'user-1', email: 'pool@example.com' };
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([row]),
      });

      const result = await service.findById('user-1', 'pi-1');
      expect(result).toEqual(row);
    });
  });

  describe('softDelete', () => {
    function mockSelectOne(row: any) {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(row ? [row] : []),
      });
    }

    function mockUpdate() {
      (db.update as jest.Mock).mockReturnValue({
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      });
    }

    it('sets status=removed for an owned pool inbox', async () => {
      mockSelectOne({ id: 'pi-1', userId: 'user-1', status: 'active' });
      mockUpdate();

      await service.softDelete('user-1', 'pi-1');

      expect(db.update).toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0];
      expect(setCall.status).toBe('removed');
    });

    it('throws not-found for a pool inbox owned by someone else', async () => {
      mockSelectOne({ id: 'pi-1', userId: 'someone-else', status: 'active' });

      await expect(service.softDelete('user-1', 'pi-1')).rejects.toThrow();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('throws not-found when the pool inbox does not exist', async () => {
      mockSelectOne(null);

      await expect(service.softDelete('user-1', 'pi-404')).rejects.toThrow();
    });

    it('is irreversible — a pool inbox already removed cannot be re-activated through this path', async () => {
      mockSelectOne({ id: 'pi-1', userId: 'user-1', status: 'removed' });
      mockUpdate();

      // Calling softDelete again on an already-removed row is a no-op
      // (still ends up removed) — but this method has no "reactivate"
      // counterpart, so re-activation simply isn't reachable through any
      // method on this service.
      await service.softDelete('user-1', 'pi-1');
      const setCall = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0];
      expect(setCall.status).toBe('removed');
    });
  });

  describe('reanalyze', () => {
    function mockSelectOne(row: any) {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(row ? [row] : []),
      });
    }

    function mockUpdate() {
      (db.update as jest.Mock).mockReturnValue({
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      });
    }

    it('throws NotFoundException when the inbox does not exist', async () => {
      mockSelectOne(null);

      await expect(service.reanalyze('user-1', 'pi-missing')).rejects.toThrow(/not found/i);
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the inbox belongs to a different user (no info-leak)', async () => {
      mockSelectOne({ id: 'pi-1', userId: 'someone-else', status: 'active' });

      await expect(service.reanalyze('user-1', 'pi-1')).rejects.toThrow(/not found/i);
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the inbox is in status=removed', async () => {
      mockSelectOne({ id: 'pi-1', userId: 'user-1', status: 'removed' });

      await expect(service.reanalyze('user-1', 'pi-1')).rejects.toThrow(/removed/i);
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('resets status=pending, enqueues inbox-analysis, and returns the new job id', async () => {
      mockSelectOne({ id: 'pi-1', userId: 'user-1', status: 'active' });
      mockUpdate();

      const result = await service.reanalyze('user-1', 'pi-1');

      expect(result).toEqual({ jobId: 'job-1' });
      const setCall = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0];
      expect(setCall.status).toBe('pending');
      expect(queueService.add).toHaveBeenCalledWith('inbox-analysis', {
        poolInboxId: 'pi-1',
        userId: 'user-1',
      });
    });
  });
});
