import { Test, TestingModule } from '@nestjs/testing';
import { QueueService } from './queue.service';
import { getQueueToken } from '@nestjs/bullmq';

describe('QueueService', () => {
  let service: QueueService;
  const mockQueue = {
    add: jest.fn(),
    getJobCounts: jest.fn(),
    getJobs: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        ...[
          'warmup-send',
          'warmup-receive',
          'dns-check',
          'blacklist-check',
          'placement-test',
          'score-compute',
          'notify',
          'token-refresh',
          'readiness-report',
          'diagnostics',
          'inbox-analysis',
        ].map((name) => ({
          provide: getQueueToken(name),
          useValue: mockQueue,
        })),
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
  });

  it('adds a job to warmup-send queue', async () => {
    await service.add('warmup-send', { inboxId: '123' });
    expect(mockQueue.add).toHaveBeenCalledWith('warmup-send', { inboxId: '123' }, undefined);
  });

  it('adds a job with options', async () => {
    await service.add('dns-check', { inboxId: '123' }, { delay: 1000 });
    expect(mockQueue.add).toHaveBeenCalledWith('dns-check', { inboxId: '123' }, { delay: 1000 });
  });

  it('adds a job to readiness-report queue', async () => {
    await service.add('readiness-report', { inboxId: '123' });
    expect(mockQueue.add).toHaveBeenCalledWith('readiness-report', { inboxId: '123' }, undefined);
  });

  it('adds a job to diagnostics queue', async () => {
    await service.add('diagnostics', { inboxId: '123', triggerType: 'auto_blacklist' });
    expect(mockQueue.add).toHaveBeenCalledWith(
      'diagnostics',
      { inboxId: '123', triggerType: 'auto_blacklist' },
      undefined,
    );
  });

  it('adds a job to inbox-analysis queue', async () => {
    await service.add('inbox-analysis', { inboxId: '123' });
    expect(mockQueue.add).toHaveBeenCalledWith('inbox-analysis', { inboxId: '123' }, undefined);
  });

  describe('removeJobsForSender', () => {
    it('removes only delayed/waiting jobs whose data.senderInboxId matches', async () => {
      const matching = { data: { senderInboxId: 'inbox-1' }, remove: jest.fn() };
      const other = { data: { senderInboxId: 'inbox-2' }, remove: jest.fn() };
      mockQueue.getJobs.mockResolvedValue([matching, other]);

      await service.removeJobsForSender('warmup-send', 'inbox-1');

      expect(mockQueue.getJobs).toHaveBeenCalledWith(['delayed', 'waiting']);
      expect(matching.remove).toHaveBeenCalledTimes(1);
      expect(other.remove).not.toHaveBeenCalled();
    });

    it('removes nothing when no jobs match', async () => {
      const other = { data: { senderInboxId: 'inbox-2' }, remove: jest.fn() };
      mockQueue.getJobs.mockResolvedValue([other]);

      await service.removeJobsForSender('warmup-send', 'inbox-1');

      expect(other.remove).not.toHaveBeenCalled();
    });
  });

  describe('removeJobsForReceiver', () => {
    it('removes only delayed/waiting jobs whose data.receiverInboxId matches', async () => {
      const matching = { data: { receiverInboxId: 'inbox-1' }, remove: jest.fn() };
      const other = { data: { receiverInboxId: 'inbox-2' }, remove: jest.fn() };
      mockQueue.getJobs.mockResolvedValue([matching, other]);

      await service.removeJobsForReceiver('warmup-receive', 'inbox-1');

      expect(mockQueue.getJobs).toHaveBeenCalledWith(['delayed', 'waiting']);
      expect(matching.remove).toHaveBeenCalledTimes(1);
      expect(other.remove).not.toHaveBeenCalled();
    });

    it('removes nothing when no jobs match', async () => {
      const other = { data: { receiverInboxId: 'inbox-2' }, remove: jest.fn() };
      mockQueue.getJobs.mockResolvedValue([other]);

      await service.removeJobsForReceiver('warmup-receive', 'inbox-1');

      expect(other.remove).not.toHaveBeenCalled();
    });
  });
});
