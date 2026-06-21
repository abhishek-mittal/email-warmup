import { Test, TestingModule } from '@nestjs/testing';
import { QueueService } from './queue.service';
import { getQueueToken } from '@nestjs/bullmq';

describe('QueueService', () => {
  let service: QueueService;
  const mockQueue = {
    add: jest.fn(),
    getJobCounts: jest.fn(),
  };

  beforeEach(async () => {
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
});
