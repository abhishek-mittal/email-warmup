import {
  renderDnsBrokenEmail,
  renderBlacklistHitEmail,
  renderScoreDropEmail,
  renderTokenRevokedEmail,
  renderWarmupCompleteEmail,
  renderTrialExpiredEmail,
  renderPlanActivatedEmail,
  renderPaymentFailedEmail,
} from './email-templates';

/**
 * Email rendering in real Gmail/Outlook is out of scope for this session
 * (T017 context addendum #8) — these tests assert structurally: the
 * generated HTML contains the expected dynamic content and contains no
 * <style> or <link> tags (inline styles only, per the non-negotiable).
 */
function expectNoExternalStyles(html: string) {
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/<link/i);
}

describe('email-templates', () => {
  describe('renderDnsBrokenEmail', () => {
    it('includes the inbox email in the subject', () => {
      const { subject } = renderDnsBrokenEmail({
        inboxEmail: 'sender@sendco.com',
        issueCodes: ['SPF_MISSING'],
      });
      expect(subject).toBe('⚠️ DNS issue detected on sender@sendco.com');
    });

    it('includes each issue code and a fix link in the HTML body', () => {
      const { html } = renderDnsBrokenEmail({
        inboxEmail: 'sender@sendco.com',
        issueCodes: ['SPF_MISSING', 'DKIM_MISSING'],
      });
      expect(html).toContain('SPF_MISSING');
      expect(html).toContain('DKIM_MISSING');
      expect(html).toContain('href="https://emailwarm.io/docs/fix-spf"');
      expect(html).toContain('href="https://emailwarm.io/docs/fix-dkim"');
      expectNoExternalStyles(html);
    });
  });

  describe('renderBlacklistHitEmail', () => {
    it('includes the inbox email in the subject', () => {
      const { subject } = renderBlacklistHitEmail({
        inboxEmail: 'sender@sendco.com',
        listed: ['zen.spamhaus.org'],
      });
      expect(subject).toBe('🚨 sender@sendco.com is blacklisted');
    });

    it('includes the specific RBL names that listed the domain', () => {
      const { html } = renderBlacklistHitEmail({
        inboxEmail: 'sender@sendco.com',
        listed: ['zen.spamhaus.org', 'bl.spamcop.net'],
      });
      expect(html).toContain('zen.spamhaus.org');
      expect(html).toContain('bl.spamcop.net');
      expectNoExternalStyles(html);
    });
  });

  describe('renderScoreDropEmail', () => {
    it('includes prev, current, and delta scores', () => {
      const { subject, html } = renderScoreDropEmail({
        inboxEmail: 'sender@sendco.com',
        prev: 80,
        current: 60,
        delta: 20,
      });
      expect(subject).toBe('📉 Reputation score dropped for sender@sendco.com');
      expect(html).toContain('80');
      expect(html).toContain('60');
      expect(html).toContain('20');
      expectNoExternalStyles(html);
    });
  });

  describe('renderTokenRevokedEmail', () => {
    it('includes the inbox email and reconnect instructions', () => {
      const { subject, html } = renderTokenRevokedEmail({ inboxEmail: 'sender@sendco.com' });
      expect(subject).toBe('🔑 Inbox disconnected: sender@sendco.com');
      expect(html).toContain('sender@sendco.com');
      expect(html.toLowerCase()).toContain('reconnect');
      expectNoExternalStyles(html);
    });
  });

  describe('renderWarmupCompleteEmail', () => {
    it('includes the recommended send volume number', () => {
      const { subject, html } = renderWarmupCompleteEmail({
        inboxEmail: 'sender@sendco.com',
        warmupDay: 30,
        recommendedDailySendVolume: 80,
      });
      expect(subject).toBe('🎉 sender@sendco.com warmup complete!');
      expect(html).toContain('80');
      expect(html).toContain('30');
      expectNoExternalStyles(html);
    });
  });

  describe('renderTrialExpiredEmail', () => {
    it('includes an upgrade CTA linking to the billing page', () => {
      const { subject, html } = renderTrialExpiredEmail({ appUrl: 'https://app.emailwarm.io' });
      expect(subject).toBe('Your 7-day trial has ended');
      expect(html).toContain('href="https://app.emailwarm.io/billing"');
      expectNoExternalStyles(html);
    });
  });

  describe('renderPlanActivatedEmail', () => {
    it('includes the plan name in the subject and body', () => {
      const { subject, html } = renderPlanActivatedEmail({ plan: 'growth' });
      expect(subject).toBe('Welcome to growth plan!');
      expect(html).toContain('growth');
      expectNoExternalStyles(html);
    });
  });

  describe('renderPaymentFailedEmail', () => {
    it('includes a working link to update payment method', () => {
      const { subject, html } = renderPaymentFailedEmail({ appUrl: 'https://app.emailwarm.io' });
      expect(subject).toBe('Payment failed — action required');
      expect(html).toContain('href="https://app.emailwarm.io/billing"');
      expect(html.toLowerCase()).toContain('update payment method');
      expectNoExternalStyles(html);
    });
  });
});
