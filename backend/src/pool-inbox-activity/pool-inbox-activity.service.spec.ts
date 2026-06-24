import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PoolInboxActivityService } from './pool-inbox-activity.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';
import { pinoLoggerStubsFor } from '../common/test-module';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const POOL_ID = 'pool-1';

describe('PoolInboxActivityService', () => {
  let service: PoolInboxActivityService;

  // Query chain stub — Drizzle calls `.from().where().groupBy().orderBy().limit()`
  // and awaits the result. We return whatever rows the test sets.
  function mockSelectChain(rows: unknown[]): any {
    const chain: any = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
      offset: jest.fn().mockResolvedValue(rows),
      then: (resolve: any) => Promise.resolve(rows).then(resolve),
    };
    (db.select as jest.Mock).mockReturnValueOnce(chain);
    return chain;
  }

  let queueService: { getJobsForReceiver: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();

    queueService = { getJobsForReceiver: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(NotFoundException, PoolInboxActivityService),
        PoolInboxActivityService,
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<PoolInboxActivityService>(PoolInboxActivityService);
  });

  // -----------------------------------------------------------------
  //  assertPoolOwnership
  // -----------------------------------------------------------------
  describe('assertPoolOwnership', () => {
    it('throws NotFound when the pool inbox does not exist', async () => {
      mockSelectChain([]);
      await expect(service.assertPoolOwnership('missing', USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFound when the pool inbox belongs to another user', async () => {
      mockSelectChain([{ id: POOL_ID, userId: OTHER_USER_ID }]);
      await expect(service.assertPoolOwnership(POOL_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the row when the pool inbox is owned by the user', async () => {
      const row = { id: POOL_ID, userId: USER_ID, email: 'pool@example.com' };
      mockSelectChain([row]);
      await expect(service.assertPoolOwnership(POOL_ID, USER_ID)).resolves.toEqual(row);
    });
  });

  // -----------------------------------------------------------------
  //  getConnectionSummary
  // -----------------------------------------------------------------
  describe('getConnectionSummary', () => {
    it('throws NotFound when the pool inbox is missing or not owned', async () => {
      mockSelectChain([]);
      await expect(service.getConnectionSummary(POOL_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns OAuth shape for gmail pool inboxes without leaking the secret', async () => {
      mockSelectChain([
        {
          id: POOL_ID,
          userId: USER_ID,
          provider: 'gmail',
          encryptedCredentials: {
            clientId: 'abc123def456ghi789jkl012',
            clientSecret: 'encrypted:ciphertext-A',
            refreshToken: 'encrypted:ciphertext-B',
          },
        },
      ]);
      const summary = await service.getConnectionSummary(POOL_ID, USER_ID);
      expect(summary.provider).toBe('gmail');
      expect(summary.oauthClientIdPrefix).toBe('abc123def456…');
      expect(summary.clientSecretPresent).toBe(true);
      expect(summary.refreshTokenPresent).toBe(true);
      expect(summary.imapConfigured).toBe(true);
      // OAuth pool inboxes have no SMTP host/port — those fields stay absent.
      expect(summary.smtpHost).toBeUndefined();
      expect(summary.smtpPort).toBeUndefined();
    });

    it('returns custom SMTP shape with IMAP present', async () => {
      mockSelectChain([
        {
          id: POOL_ID,
          userId: USER_ID,
          provider: 'custom',
          encryptedCredentials: {
            smtpHost: 'smtp.gmail.com',
            smtpPort: 587,
            smtpUser: 'me@gmail.com',
            smtpPassword: 'encrypted:ciphertext-C',
            imapHost: 'imap.gmail.com',
            imapPort: 993,
            imapUser: 'me@gmail.com',
            imapPassword: 'encrypted:ciphertext-D',
          },
        },
      ]);
      const summary = await service.getConnectionSummary(POOL_ID, USER_ID);
      expect(summary.provider).toBe('custom');
      expect(summary.smtpHost).toBe('smtp.gmail.com');
      expect(summary.smtpPort).toBe(587);
      expect(summary.smtpUser).toBe('me@gmail.com');
      expect(summary.smtpPasswordPresent).toBe(true);
      expect(summary.imapConfigured).toBe(true);
      expect(summary.imapHost).toBe('imap.gmail.com');
      expect(summary.imapPort).toBe(993);
      expect(summary.imapPasswordPresent).toBe(true);
    });

    it('flags imapConfigured=false when custom SMTP is missing IMAP', async () => {
      mockSelectChain([
        {
          id: POOL_ID,
          userId: USER_ID,
          provider: 'custom',
          encryptedCredentials: {
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpUser: 'me@example.com',
            smtpPassword: 'encrypted:ciphertext-E',
            // No IMAP fields at all
          },
        },
      ]);
      const summary = await service.getConnectionSummary(POOL_ID, USER_ID);
      expect(summary.imapConfigured).toBe(false);
      expect(summary.imapHost).toBeUndefined();
      expect(summary.imapPort).toBeUndefined();
      expect(summary.imapPasswordPresent).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  //  getActivityStats
  // -----------------------------------------------------------------
  describe('getActivityStats', () => {
    it('returns all zeros + null rates when no rows', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership ok
      mockSelectChain([]);
      const stats = await service.getActivityStats(POOL_ID, USER_ID);
      expect(stats).toEqual({
        received: 0,
        opened: 0,
        replied: 0,
        rescued: 0,
        spamCount: 0,
        openRate: null,
        replyRate: null,
        spamRate: null,
      });
    });

    it('computes counts and rates correctly', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership ok
      // 10 rows: 8 opened, 5 replied, 2 rescued, 1 landedInSpam
      const rows = Array.from({ length: 10 }, (_, i) => ({
        openedAt: i < 8 ? new Date() : null,
        repliedAt: i < 5 ? new Date() : null,
        rescuedAt: i < 2 ? new Date() : null,
        landedInSpam: i === 0,
      }));
      mockSelectChain(rows);
      const stats = await service.getActivityStats(POOL_ID, USER_ID);
      expect(stats.received).toBe(10);
      expect(stats.opened).toBe(8);
      expect(stats.replied).toBe(5);
      expect(stats.rescued).toBe(2);
      expect(stats.spamCount).toBe(1);
      expect(stats.openRate).toBe(80);
      expect(stats.replyRate).toBe(50);
      expect(stats.spamRate).toBe(10);
    });
  });

  // -----------------------------------------------------------------
  //  getActivity — receiver-side fan-out
  // -----------------------------------------------------------------
  describe('getActivity', () => {
    it('throws NotFound when the pool inbox is missing', async () => {
      mockSelectChain([]);
      await expect(service.getActivity(POOL_ID, USER_ID, null, 50)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('fans out one warmup_sends row into received + opened + replied + filed + spam_landed', async () => {
      // First select: ownership check (returns owned row)
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]);
      // Second select: warmup_sends rows for this pool inbox
      mockSelectChain([
        {
          id: 'ws-1',
          senderInboxId: 'sender-1',
          createdAt: new Date('2026-06-20T10:00:00Z'),
          sentAt: new Date('2026-06-20T10:00:05Z'),
          openedAt: new Date('2026-06-20T10:05:00Z'),
          repliedAt: new Date('2026-06-20T10:30:00Z'),
          starredAt: null,
          rescuedAt: null,
          filedAt: new Date('2026-06-20T10:35:00Z'),
          landedInSpam: true,
          landedInTab: 'spam',
          subject: 'Test subject',
          messageId: '<msg-1@warm>',
        },
      ]);
      // Third select: resolve sender inbox emails
      mockSelectChain([{ id: 'sender-1', email: 'sender@example.com' }]);

      const result = await service.getActivity(POOL_ID, USER_ID, null, 50);
      const types = result.events.map((e) => e.type).sort();
      // received + opened + replied + filed + spam_landed = 5 events
      expect(types).toEqual(
        expect.arrayContaining(['received', 'opened', 'replied', 'filed', 'spam_landed']),
      );
      // Each event carries senderEmail + subject
      for (const ev of result.events) {
        expect(ev.payload.senderEmail).toBe('sender@example.com');
        expect(ev.payload.subject).toBe('Test subject');
      }
    });

    it('returns empty events when no warmup_sends reference this pool inbox', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership ok
      mockSelectChain([]); // no warmup_sends
      const result = await service.getActivity(POOL_ID, USER_ID, null, 50);
      expect(result.events).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  //  getPairings
  // -----------------------------------------------------------------
  describe('getPairings', () => {
    it('returns empty pairings when no sends reference this pool inbox', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID, activePairs: 0 }]); // ownership
      mockSelectChain([]); // grouped sends
      const result = await service.getPairings(POOL_ID, USER_ID);
      expect(result.activePairs).toBe(0);
      expect(result.pairings).toEqual([]);
    });

    it('returns aggregated counts per sender inbox', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID, activePairs: 2 }]); // ownership
      mockSelectChain([
        {
          senderInboxId: 'inbox-A',
          emailsSent: 15,
          lastSendAt: new Date('2026-06-20T09:00:00Z'),
        },
        {
          senderInboxId: 'inbox-B',
          emailsSent: 7,
          lastSendAt: new Date('2026-06-19T18:00:00Z'),
        },
      ]);
      mockSelectChain([
        {
          id: 'inbox-A',
          email: 'a@example.com',
          provider: 'gmail',
          warmupDay: 12,
          status: 'active',
        },
        {
          id: 'inbox-B',
          email: 'b@example.com',
          provider: 'outlook',
          warmupDay: 5,
          status: 'paused',
        },
      ]);

      const result = await service.getPairings(POOL_ID, USER_ID);
      expect(result.activePairs).toBe(2);
      expect(result.pairings).toHaveLength(2);
      // Ordered by emailsSent desc (mock data above is already in order)
      expect(result.pairings[0]).toMatchObject({
        inboxId: 'inbox-A',
        inboxEmail: 'a@example.com',
        inboxProvider: 'gmail',
        warmupDay: 12,
        emailsSent: 15,
        status: 'active',
      });
      expect(result.pairings[0].lastSendAt).toBe('2026-06-20T09:00:00.000Z');
      expect(result.pairings[1].inboxEmail).toBe('b@example.com');
    });
  });

  // -----------------------------------------------------------------
  //  getLiveStatus
  // -----------------------------------------------------------------
  describe('getLiveStatus', () => {
    it('throws NotFound when the pool inbox is missing or not owned', async () => {
      mockSelectChain([]);
      await expect(service.getLiveStatus(POOL_ID, USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns empty active/upcoming when no jobs are queued', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership
      queueService.getJobsForReceiver.mockResolvedValue([]);

      const result = await service.getLiveStatus(POOL_ID, USER_ID);

      expect(result).toEqual({ active: [], upcoming: [] });
      expect(queueService.getJobsForReceiver).toHaveBeenCalledWith('warmup-receive', POOL_ID, [
        'active',
        'delayed',
        'waiting',
      ]);
    });

    it('splits jobs into active vs upcoming by BullMQ state, resolves sender email, sorts upcoming by executeAt ascending, caps upcoming at 5', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership

      const now = Date.now();
      function makeJob(id: string, state: string, executeAt: string, messageId: string) {
        return {
          id,
          getState: jest.fn().mockResolvedValue(state),
          data: { actions: ['open', 'star'], executeAt, messageId },
        };
      }
      const activeJob = makeJob('job-active', 'active', new Date(now).toISOString(), '<m1>');
      const upcomingJobs = Array.from({ length: 6 }, (_, i) =>
        makeJob(
          `job-up-${i}`,
          'delayed',
          new Date(now + (6 - i) * 60_000).toISOString(),
          `<m-up-${i}>`,
        ),
      );
      queueService.getJobsForReceiver.mockResolvedValue([activeJob, ...upcomingJobs]);

      // Batched lookup: warmup_sends rows for all messageIds, then inboxes for senderInboxId -> email.
      mockSelectChain(
        [activeJob, ...upcomingJobs].map((j) => ({
          messageId: j.data.messageId,
          senderInboxId: `sender-${j.id}`,
        })),
      );
      mockSelectChain(
        [activeJob, ...upcomingJobs].map((j) => ({
          id: `sender-${j.id}`,
          email: `${j.id}@example.com`,
        })),
      );

      const result = await service.getLiveStatus(POOL_ID, USER_ID);

      expect(result.active).toHaveLength(1);
      expect(result.active[0]).toMatchObject({
        jobId: 'job-active',
        senderEmail: 'job-active@example.com',
        state: 'active',
      });

      // Capped at 5, sorted ascending by executeAt (soonest first = job-up-5
      // which has the smallest offset, 1 minute).
      expect(result.upcoming).toHaveLength(5);
      expect(result.upcoming[0].jobId).toBe('job-up-5');
      expect(result.upcoming[4].jobId).toBe('job-up-1');
    });

    it('excludes a job whose getState() resolves outside the active/delayed/waiting contract, while a normal job in the same batch still appears', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership

      function makeJob(id: string, state: string, executeAt: string, messageId: string) {
        return {
          id,
          getState: jest.fn().mockResolvedValue(state),
          data: { actions: ['open'], executeAt, messageId },
        };
      }
      const now = Date.now();
      // Raced job: fetched as 'active'/'delayed'/'waiting' by getJobsForReceiver,
      // but by the time getState() resolves it has already completed.
      const racedJob = makeJob('job-raced', 'completed', new Date(now).toISOString(), '<m-raced>');
      const normalJob = makeJob('job-normal', 'active', new Date(now).toISOString(), '<m-normal>');
      queueService.getJobsForReceiver.mockResolvedValue([racedJob, normalJob]);

      // Batched lookup: warmup_sends rows for all messageIds, then inboxes for senderInboxId -> email.
      mockSelectChain(
        [racedJob, normalJob].map((j) => ({
          messageId: j.data.messageId,
          senderInboxId: `sender-${j.id}`,
        })),
      );
      mockSelectChain(
        [racedJob, normalJob].map((j) => ({
          id: `sender-${j.id}`,
          email: `${j.id}@example.com`,
        })),
      );

      const result = await service.getLiveStatus(POOL_ID, USER_ID);

      // The raced job lands in neither bucket.
      expect(result.active.find((j) => j.jobId === 'job-raced')).toBeUndefined();
      expect(result.upcoming.find((j) => j.jobId === 'job-raced')).toBeUndefined();

      // The normal job is unaffected and still appears as active.
      expect(result.active).toHaveLength(1);
      expect(result.active[0]).toMatchObject({
        jobId: 'job-normal',
        senderEmail: 'job-normal@example.com',
        state: 'active',
      });
      expect(result.upcoming).toHaveLength(0);
    });
  });
});
