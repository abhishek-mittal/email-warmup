import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { NotifyProcessor } from './notify.processor';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

// The `jest.mock` factory must not reference any top-level binding because
// ts-jest hoists `jest.mock(...)` calls above all `const` initializers in
// the file (they'd be in the temporal dead zone when the factory runs).
// We define the mock fn INSIDE the factory and recover it later by calling
// `nodemailer.createTransport` once and capturing the returned object.
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const sendMailMock = jest.fn();
const createTransportMock = require('nodemailer').createTransport as jest.Mock;
(createTransportMock as jest.Mock).mockImplementation(() => ({ sendMail: sendMailMock }));

const fetchMock = jest.fn();
(global as any).fetch = fetchMock;

describe('NotifyProcessor', () => {
  let processor: NotifyProcessor;

  const user = {
    id: 'user-1',
    email: 'owner@example.com',
    plan: 'growth',
    slackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/XXX',
  };

  const inbox = {
    id: 'inbox-1',
    userId: 'user-1',
    email: 'sender@sendco.com',
  };

  /**
   * Sequenced db.select() mock — call order is asserted indirectly via which
   * rows are returned for which lookup. NotifyProcessor looks up `users` by
   * userId, then (when inboxId is present and the template needs it)
   * `inboxes` by inboxId, then (for warmup_complete only) the latest
   * `diagnostics` row with triggerType = 'graduation'.
   */
  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
    });
  }

  function makeJob(data: Record<string, any>) {
    return { data } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    process.env.PLATFORM_SMTP_HOST = 'smtp.platform.test';
    process.env.PLATFORM_SMTP_PORT = '587';
    process.env.PLATFORM_SMTP_USER = 'noreply@emailwarm.io';
    process.env.PLATFORM_SMTP_PASS = 'secret';
    process.env.PLATFORM_FROM_EMAIL = 'EmailWarm <noreply@emailwarm.io>';
    process.env.APP_URL = 'https://app.emailwarm.io';

    const module: TestingModule = await Test.createTestingModule({
      providers: [NotifyProcessor],
    }).compile();

    processor = module.get<NotifyProcessor>(NotifyProcessor);
  });

  describe('channel: email', () => {
    it('throws UnrecoverableError when the user cannot be found', async () => {
      mockSelectSequence([[]]);

      await expect(
        processor.process(
          makeJob({ userId: 'user-1', type: 'trial_expired', channel: 'email', payload: {} }),
        ),
      ).rejects.toThrow(UnrecoverableError);
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('sends a dns_broken email to the user via platform SMTP using the inbox email', async () => {
      mockSelectSequence([[user], [inbox]]);

      await processor.process(
        makeJob({
          userId: 'user-1',
          inboxId: 'inbox-1',
          type: 'dns_broken',
          channel: 'email',
          payload: { issueCodes: ['SPF_MISSING'] },
        }),
      );

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.platform.test',
          port: 587,
          auth: { user: 'noreply@emailwarm.io', pass: 'secret' },
        }),
      );
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'EmailWarm <noreply@emailwarm.io>',
          to: 'owner@example.com',
          subject: expect.stringContaining('sender@sendco.com'),
          html: expect.stringContaining('SPF_MISSING'),
        }),
      );
    });

    it('throws UnrecoverableError when the inbox cannot be found for an inbox-scoped template', async () => {
      mockSelectSequence([[user], []]);

      await expect(
        processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'dns_broken',
            channel: 'email',
            payload: { issueCodes: ['SPF_MISSING'] },
          }),
        ),
      ).rejects.toThrow(UnrecoverableError);
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('sends trial_expired email without looking up an inbox', async () => {
      mockSelectSequence([[user]]);

      await processor.process(
        makeJob({ userId: 'user-1', type: 'trial_expired', channel: 'email', payload: {} }),
      );

      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@example.com',
          subject: 'Your 7-day trial has ended',
        }),
      );
    });

    describe('warmup_complete race condition (addendum #5)', () => {
      const graduationDiagnosticsRow = {
        id: 'diag-1',
        inboxId: 'inbox-1',
        triggerType: 'graduation',
        readinessReport: { recommendedDailySendVolume: 80 },
      };

      it('includes recommendedDailySendVolume from the diagnostics row when found', async () => {
        mockSelectSequence([[user], [inbox], [graduationDiagnosticsRow]]);

        await processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'warmup_complete',
            channel: 'email',
            payload: { warmupDay: 30 },
          }),
        );

        expect(sendMailMock).toHaveBeenCalledWith(
          expect.objectContaining({
            html: expect.stringContaining('80'),
          }),
        );
      });

      it('throws (not an incomplete send) when the graduation diagnostics row is not found yet', async () => {
        mockSelectSequence([[user], [inbox], []]);

        await expect(
          processor.process(
            makeJob({
              userId: 'user-1',
              inboxId: 'inbox-1',
              type: 'warmup_complete',
              channel: 'email',
              payload: { warmupDay: 30 },
            }),
          ),
        ).rejects.toThrow();
        expect(sendMailMock).not.toHaveBeenCalled();
      });
    });

    describe('inline Slack fan-out (addendum #1, #2, #4)', () => {
      it('posts to Slack after sending email when inboxId present, plan is growth+, and webhook is set', async () => {
        mockSelectSequence([[user], [inbox]]);

        await processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'dns_broken',
            channel: 'email',
            payload: { issueCodes: ['SPF_MISSING'] },
          }),
        );

        expect(sendMailMock).toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledWith(
          'https://hooks.slack.com/services/T000/B000/XXX',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          }),
        );
        const slackCallOrder = fetchMock.mock.invocationCallOrder[0];
        const emailCallOrder = sendMailMock.mock.invocationCallOrder[0];
        expect(emailCallOrder).toBeLessThan(slackCallOrder);
      });

      it('does NOT enqueue a second notify job for the Slack fan-out', async () => {
        mockSelectSequence([[user], [inbox]]);
        // No QueueService is even injected into NotifyProcessor — fan-out is
        // inline within the same job execution (addendum #1).
        await processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'dns_broken',
            channel: 'email',
            payload: { issueCodes: ['SPF_MISSING'] },
          }),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('does NOT post to Slack when inboxId is absent (user-level event)', async () => {
        mockSelectSequence([[user]]);

        await processor.process(
          makeJob({ userId: 'user-1', type: 'trial_expired', channel: 'email', payload: {} }),
        );

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('does NOT post to Slack when plan is trial/starter even with inboxId and webhook set', async () => {
        const trialUser = { ...user, plan: 'trial' };
        mockSelectSequence([[trialUser], [inbox]]);

        await processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'dns_broken',
            channel: 'email',
            payload: { issueCodes: ['SPF_MISSING'] },
          }),
        );

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('does NOT post to Slack when growth+ plan but no slackWebhookUrl is set', async () => {
        const noWebhookUser = { ...user, slackWebhookUrl: null };
        mockSelectSequence([[noWebhookUser], [inbox]]);

        await processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'dns_broken',
            channel: 'email',
            payload: { issueCodes: ['SPF_MISSING'] },
          }),
        );

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('still sends the email even when Slack fan-out is skipped due to plan gate', async () => {
        const trialUser = { ...user, plan: 'starter' };
        mockSelectSequence([[trialUser], [inbox]]);

        await processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'dns_broken',
            channel: 'email',
            payload: { issueCodes: ['SPF_MISSING'] },
          }),
        );

        expect(sendMailMock).toHaveBeenCalled();
      });
    });
  });

  describe('channel: slack (direct, forward-compatibility per addendum #1)', () => {
    it('sends only to Slack, with no plan re-check, when webhook URL exists', async () => {
      const trialUser = { ...user, plan: 'trial' };
      mockSelectSequence([[trialUser], [inbox]]);

      await processor.process(
        makeJob({
          userId: 'user-1',
          inboxId: 'inbox-1',
          type: 'score_drop',
          channel: 'slack',
          payload: { prev: 80, current: 60, delta: 20 },
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('throws UnrecoverableError when no slackWebhookUrl is set for a direct slack job', async () => {
      const noWebhookUser = { ...user, slackWebhookUrl: null };
      mockSelectSequence([[noWebhookUser], [inbox]]);

      await expect(
        processor.process(
          makeJob({
            userId: 'user-1',
            inboxId: 'inbox-1',
            type: 'score_drop',
            channel: 'slack',
            payload: { prev: 80, current: 60, delta: 20 },
          }),
        ),
      ).rejects.toThrow(UnrecoverableError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('SMTP failure retry behavior', () => {
    it('propagates the SMTP error so BullMQ retries (no swallowing)', async () => {
      mockSelectSequence([[user]]);
      sendMailMock.mockRejectedValue(new Error('SMTP connection refused'));

      await expect(
        processor.process(
          makeJob({ userId: 'user-1', type: 'trial_expired', channel: 'email', payload: {} }),
        ),
      ).rejects.toThrow('SMTP connection refused');
    });
  });
});
