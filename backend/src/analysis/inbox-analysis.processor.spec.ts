import { Test, TestingModule } from '@nestjs/testing';
import { InboxAnalysisProcessor } from './inbox-analysis.processor';
import { AnalysisService } from './analysis.service';

import { pinoLoggerStubsFor } from '../common/test-module';
describe('InboxAnalysisProcessor', () => {
  let processor: InboxAnalysisProcessor;
  let analysisService: { analyse: jest.Mock };

  function makeJob(
    overrides: Partial<{ inboxId: string; poolInboxId: string; userId: string }> = {},
  ) {
    return { data: { userId: 'user-1', ...overrides } } as any;
  }

  beforeEach(async () => {
    analysisService = { analyse: jest.fn().mockResolvedValue({ id: 'analysis-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [...pinoLoggerStubsFor(InboxAnalysisProcessor, AnalysisService, Error),
      InboxAnalysisProcessor, { provide: AnalysisService, useValue: analysisService }],
    }).compile();

    processor = module.get<InboxAnalysisProcessor>(InboxAnalysisProcessor);
  });

  it('delegates straight to AnalysisService.analyse with the job payload for an inbox-to-warm', async () => {
    await processor.process(makeJob({ inboxId: 'inbox-1' }));

    expect(analysisService.analyse).toHaveBeenCalledWith({
      inboxId: 'inbox-1',
      poolInboxId: undefined,
      userId: 'user-1',
    });
  });

  it('delegates straight to AnalysisService.analyse with the job payload for a pool inbox', async () => {
    await processor.process(makeJob({ poolInboxId: 'pool-1' }));

    expect(analysisService.analyse).toHaveBeenCalledWith({
      inboxId: undefined,
      poolInboxId: 'pool-1',
      userId: 'user-1',
    });
  });

  it('propagates errors thrown by AnalysisService.analyse (e.g. UnrecoverableError for a missing row)', async () => {
    const err = new Error('boom');
    analysisService.analyse.mockRejectedValue(err);

    await expect(processor.process(makeJob({ inboxId: 'inbox-1' }))).rejects.toThrow('boom');
  });
});
