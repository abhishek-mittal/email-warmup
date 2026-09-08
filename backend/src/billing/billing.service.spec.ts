import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BillingService, PLAN_LIMITS } from './billing.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
  },
}));

const mockStripeCheckoutCreate = jest.fn();
const mockStripePortalCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockStripeCheckoutCreate,
      },
    },
    billingPortal: {
      sessions: {
        create: mockStripePortalCreate,
      },
    },
  }));
});

describe('BillingService', () => {
  let service: BillingService;
  let queueService: { add: jest.Mock };

  function mockSelectChain(returnValue: any[]) {
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(returnValue),
    };
    (db.select as jest.Mock).mockReturnValue(chain);
    return chain;
  }

  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      const chain: any = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
      chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
      return chain;
    });
  }

  function mockUpdate() {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    (db.update as jest.Mock).mockReturnValue({ set: setMock });
    return { setMock, whereMock };
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(
          BadRequestException,
          ForbiddenException,
          BillingService,
          PLAN_LIMITS,
          QueueService,
          db,
        ),

        BillingService,
        {
          provide: QueueService,
          useValue: {
            add: jest.fn(),
            removeJobsForSender: jest.fn().mockResolvedValue(undefined),
            removeJobsForReceiver: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = module.get<BillingService>(BillingService);
    queueService = module.get(QueueService);
    jest.clearAllMocks();

    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    process.env.STRIPE_PRICE_GROWTH = 'price_growth';
    process.env.STRIPE_PRICE_AGENCY = 'price_agency';
    process.env.APP_URL = 'https://app.test';
  });

  describe('PLAN_LIMITS', () => {
    it('keeps the existing inboxes field for already-merged callers', () => {
      expect(PLAN_LIMITS.growth.inboxes).toBe(20);
      expect(PLAN_LIMITS.trial.inboxes).toBe(3);
      expect(PLAN_LIMITS.agency.inboxes).toBe(100);
    });

    it('adds a free tier with zero inboxes', () => {
      expect(PLAN_LIMITS.free).toEqual({
        inboxes: 0,
        placementTests: 0,
        diagnosticsAi: false,
        slackAlerts: false,
      });
    });

    it('extends every plan with the richer entitlement shape', () => {
      expect(PLAN_LIMITS.growth).toEqual({
        inboxes: 20,
        placementTests: 5,
        diagnosticsAi: true,
        slackAlerts: true,
      });
      expect(PLAN_LIMITS.agency).toEqual({
        inboxes: 100,
        placementTests: -1,
        diagnosticsAi: true,
        slackAlerts: true,
      });
      expect(PLAN_LIMITS.enterprise).toEqual({
        inboxes: -1,
        placementTests: -1,
        diagnosticsAi: true,
        slackAlerts: true,
      });
    });
  });

  describe('assertPlan / assertInboxLimit (existing behavior preserved)', () => {
    it('throws when user plan is not allowed', async () => {
      mockSelectChain([{ id: 'u1', plan: 'trial' }]);
      await expect(service.assertPlan('u1', ['growth'])).rejects.toThrow(ForbiddenException);
    });

    it('passes when user plan is allowed', async () => {
      mockSelectChain([{ id: 'u1', plan: 'growth' }]);
      await expect(service.assertPlan('u1', ['growth'])).resolves.toBeUndefined();
    });

    it('throws when inbox limit reached', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ id: 'u1', plan: 'trial' }]),
      });
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([{ count: PLAN_LIMITS.trial.inboxes }]),
      });

      await expect(service.assertInboxLimit('u1')).rejects.toThrow(ForbiddenException);
    });

    it('rejects a free-plan user immediately (0 limit), satisfying post-trial-expiry 403', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ id: 'u1', plan: 'free' }]),
      });
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([{ count: 0 }]),
      });

      await expect(service.assertInboxLimit('u1')).rejects.toThrow(ForbiddenException);
    });

    it('never rejects an enterprise-plan user (inboxes: -1 is the unlimited sentinel)', async () => {
      // Regression test: `count >= -1` is always true, so before the fix this
      // threw ForbiddenException for an enterprise user with zero inboxes.
      expect(PLAN_LIMITS.enterprise.inboxes).toBe(-1);
      mockSelectChain([{ id: 'u1', plan: 'enterprise' }]);

      await expect(service.assertInboxLimit('u1')).resolves.toBeUndefined();
      // Only one db.select call (the user lookup) — the inbox count query is
      // skipped entirely for the unlimited sentinel.
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('planFromPriceId', () => {
    it('maps each configured price id to its plan name', () => {
      expect(service.planFromPriceId('price_starter')).toBe('starter');
      expect(service.planFromPriceId('price_growth')).toBe('growth');
      expect(service.planFromPriceId('price_agency')).toBe('agency');
    });

    it('throws for an unrecognized price id', () => {
      expect(() => service.planFromPriceId('price_unknown')).toThrow();
    });
  });

  describe('createCheckoutSession', () => {
    it('rejects plan=enterprise (handled manually, no Stripe price)', async () => {
      mockSelectChain([{ id: 'u1', email: 'u1@test.com', plan: 'trial', stripeCustomerId: null }]);

      await expect(service.createCheckoutSession('u1', 'enterprise')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockStripeCheckoutCreate).not.toHaveBeenCalled();
    });

    it('rejects an unknown plan string', async () => {
      mockSelectChain([{ id: 'u1', email: 'u1@test.com', plan: 'trial', stripeCustomerId: null }]);

      await expect(service.createCheckoutSession('u1', 'bogus')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates a subscription-mode checkout session using the env-configured price id', async () => {
      mockSelectChain([{ id: 'u1', email: 'u1@test.com', plan: 'trial', stripeCustomerId: null }]);
      mockStripeCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/abc' });

      const result = await service.createCheckoutSession('u1', 'growth');

      expect(result).toEqual({ url: 'https://checkout.stripe.com/abc' });
      expect(mockStripeCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: 'price_growth', quantity: 1 }],
          success_url: expect.stringContaining('https://app.test'),
          cancel_url: expect.stringContaining('https://app.test'),
          metadata: { userId: 'u1', plan: 'growth' },
        }),
      );
    });

    it('reuses an existing stripeCustomerId rather than passing customer_email', async () => {
      mockSelectChain([
        { id: 'u1', email: 'u1@test.com', plan: 'starter', stripeCustomerId: 'cus_existing' },
      ]);
      mockStripeCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/xyz' });

      await service.createCheckoutSession('u1', 'growth');

      const args = mockStripeCheckoutCreate.mock.calls[0][0];
      expect(args.customer).toBe('cus_existing');
      expect(args.customer_email).toBeUndefined();
    });

    it('throws when the user cannot be found', async () => {
      mockSelectChain([]);
      await expect(service.createCheckoutSession('missing', 'growth')).rejects.toThrow();
    });
  });

  describe('createPortalSession', () => {
    it('throws BadRequestException when the user has no stripeCustomerId', async () => {
      mockSelectChain([{ id: 'u1', stripeCustomerId: null }]);
      await expect(service.createPortalSession('u1')).rejects.toThrow(BadRequestException);
    });

    it('creates a portal session for a user with an existing customer id', async () => {
      mockSelectChain([{ id: 'u1', stripeCustomerId: 'cus_123' }]);
      mockStripePortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/p/123' });

      const result = await service.createPortalSession('u1');

      expect(result).toEqual({ url: 'https://billing.stripe.com/p/123' });
      expect(mockStripePortalCreate).toHaveBeenCalledWith({
        customer: 'cus_123',
        return_url: expect.stringContaining('https://app.test'),
      });
    });
  });

  describe('activatePlan', () => {
    it('sets plan, stripeSubId, stripeCustomerId, clears trialEndsAt, and enqueues plan_activated', async () => {
      const { setMock, whereMock } = mockUpdate();

      await service.activatePlan('u1', 'growth', 'sub_123', 'cus_123');

      expect(setMock).toHaveBeenCalledWith({
        plan: 'growth',
        stripeSubId: 'sub_123',
        stripeCustomerId: 'cus_123',
        trialEndsAt: null,
      });
      expect(whereMock).toHaveBeenCalled();
      expect(queueService.add).toHaveBeenCalledWith('notify', {
        userId: 'u1',
        type: 'plan_activated',
        channel: 'email',
        payload: { plan: 'growth' },
      });
    });
  });

  describe('updatePlan', () => {
    it('updates the plan without touching trial/stripe id fields', async () => {
      const { setMock } = mockUpdate();

      await service.updatePlan('u1', 'agency');

      expect(setMock).toHaveBeenCalledWith({ plan: 'agency' });
    });
  });

  describe('downgradePlan', () => {
    it('pauses all of the user inboxes BEFORE setting plan to free', async () => {
      mockSelectSequence([
        [
          { id: 'inbox-1', userId: 'u1' },
          { id: 'inbox-2', userId: 'u1' },
        ],
      ]);
      const { setMock, whereMock } = mockUpdate();
      whereMock.mockResolvedValue(undefined);

      await service.downgradePlan('u1');

      // First two update calls pause inboxes, last call sets plan to free.
      const setCalls = setMock.mock.calls.map((c) => c[0]);
      expect(setCalls).toEqual([{ status: 'paused' }, { status: 'paused' }, { plan: 'free' }]);
      // No notification type is spec'd for downgradePlan (only activatePlan/
      // handlePaymentFailure/expireTrials have one — addendum #6).
      expect(queueService.add).not.toHaveBeenCalledWith('notify', expect.anything());
    });

    it('removes pending send/receive jobs for every paused inbox', async () => {
      mockSelectSequence([[{ id: 'inbox-1', userId: 'u1' }]]);
      mockUpdate();
      const queueServiceMock = queueService as unknown as {
        removeJobsForSender: jest.Mock;
        removeJobsForReceiver: jest.Mock;
      };

      await service.downgradePlan('u1');

      expect(queueServiceMock.removeJobsForSender).toHaveBeenCalledWith('warmup-send', 'inbox-1');
      expect(queueServiceMock.removeJobsForReceiver).toHaveBeenCalledWith(
        'warmup-receive',
        'inbox-1',
      );
    });
  });

  describe('handlePaymentFailure', () => {
    it('finds the user by stripeCustomerId and enqueues a payment_failed notification', async () => {
      mockSelectChain([{ id: 'u1', stripeCustomerId: 'cus_123' }]);

      await service.handlePaymentFailure('cus_123');

      expect(queueService.add).toHaveBeenCalledWith('notify', {
        userId: 'u1',
        type: 'payment_failed',
        channel: 'email',
        payload: {},
      });
    });

    it('does nothing when no user matches the customer id', async () => {
      mockSelectChain([]);

      await service.handlePaymentFailure('cus_unknown');

      expect(queueService.add).not.toHaveBeenCalled();
    });
  });
});
