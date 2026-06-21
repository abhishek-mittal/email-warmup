import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { BillingService, PLAN_LIMITS } from './billing.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('BillingService', () => {
  let service: BillingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BillingService],
    }).compile();
    service = module.get<BillingService>(BillingService);
    jest.clearAllMocks();
  });

  function mockSelectChain(returnValue: any[]) {
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(returnValue),
    };
    (db.select as jest.Mock).mockReturnValue(chain);
    return chain;
  }

  it('throws when user plan is not allowed', async () => {
    mockSelectChain([{ id: 'u1', plan: 'trial' }]);
    await expect(service.assertPlan('u1', ['growth'])).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('passes when user plan is allowed', async () => {
    mockSelectChain([{ id: 'u1', plan: 'growth' }]);
    await expect(service.assertPlan('u1', ['growth'])).resolves.toBeUndefined();
  });

  it('throws when inbox limit reached', async () => {
    mockSelectChain([{ id: 'u1', plan: 'trial' }]);
    const countChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ count: PLAN_LIMITS.trial.inboxes }]),
    };
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 'u1', plan: 'trial' }]),
    });
    (db.select as jest.Mock).mockReturnValueOnce(countChain);

    await expect(service.assertInboxLimit('u1')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
