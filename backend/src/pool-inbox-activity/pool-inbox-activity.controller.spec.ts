import { Test, TestingModule } from '@nestjs/testing';
import { PoolInboxActivityController } from './pool-inbox-activity.controller';
import { PoolInboxActivityService } from './pool-inbox-activity.service';
import { pinoLoggerStubsFor } from '../common/test-module';

describe('PoolInboxActivityController', () => {
  let controller: PoolInboxActivityController;
  let service: Record<string, jest.Mock>;

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    service = {
      getConnectionSummary: jest.fn(),
      getActivity: jest.fn(),
      getActivityStats: jest.fn(),
      getPairings: jest.fn(),
      getLogs: jest.fn(),
      getLiveStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PoolInboxActivityController],
      providers: [
        ...pinoLoggerStubsFor(PoolInboxActivityController, PoolInboxActivityService),
        { provide: PoolInboxActivityService, useValue: service },
      ],
    }).compile();

    controller = module.get<PoolInboxActivityController>(PoolInboxActivityController);
  });

  describe('GET /pool-inboxes/:id/live-status', () => {
    it('delegates to PoolInboxActivityService.getLiveStatus and returns the result', async () => {
      const payload = { active: [], upcoming: [] };
      service.getLiveStatus.mockResolvedValue(payload);

      const result = await controller.liveStatus(makeReq('user-1'), 'pool-1');

      expect(service.getLiveStatus).toHaveBeenCalledWith('pool-1', 'user-1');
      expect(result).toEqual(payload);
    });
  });
});
