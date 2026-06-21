import { formatSlackMessage, SlackAlertType } from './slack-formatter';

/**
 * Block Kit structure per T017 context addendum #10: header + section +
 * context always; an actions block ("View dashboard" button) only for the
 * 4 truly critical inbox alert types. warmup_complete (positive event) gets
 * no action button.
 */
describe('formatSlackMessage', () => {
  const ACTIONS_TYPES: SlackAlertType[] = [
    'dns_broken',
    'blacklist_hit',
    'score_drop',
    'token_revoked',
  ];

  it.each(ACTIONS_TYPES)(
    'includes an actions block with a View dashboard button for %s',
    (type) => {
      const message = formatSlackMessage({
        type,
        inboxEmail: 'sender@sendco.com',
        inboxId: 'inbox-1',
        appUrl: 'https://app.emailwarm.io',
        payload: {},
      });

      const actionsBlock = message.blocks.find((b: any) => b.type === 'actions')!;
      expect(actionsBlock).toBeDefined();
      const button = actionsBlock.elements[0];
      expect(button.text.text).toContain('View dashboard');
      expect(button.url).toBe('https://app.emailwarm.io/inboxes/inbox-1');
    },
  );

  it('does NOT include an actions block for warmup_complete', () => {
    const message = formatSlackMessage({
      type: 'warmup_complete',
      inboxEmail: 'sender@sendco.com',
      inboxId: 'inbox-1',
      appUrl: 'https://app.emailwarm.io',
      payload: { recommendedDailySendVolume: 80 },
    });

    const actionsBlock = message.blocks.find((b: any) => b.type === 'actions')!;
    expect(actionsBlock).toBeUndefined();
  });

  it('builds a header block with the dns_broken icon and title', () => {
    const message = formatSlackMessage({
      type: 'dns_broken',
      inboxEmail: 'sender@sendco.com',
      inboxId: 'inbox-1',
      appUrl: 'https://app.emailwarm.io',
      payload: { issueCodes: ['SPF_MISSING'] },
    });

    const header = message.blocks.find((b: any) => b.type === 'header')!;
    expect(header.text.text).toContain('⚠️');
    expect(header.text.text.toLowerCase()).toContain('dns');
  });

  it('includes inbox email and the listed RBL names for blacklist_hit', () => {
    const message = formatSlackMessage({
      type: 'blacklist_hit',
      inboxEmail: 'sender@sendco.com',
      inboxId: 'inbox-1',
      appUrl: 'https://app.emailwarm.io',
      payload: { listed: ['zen.spamhaus.org', 'bl.spamcop.net'] },
    });

    const header = message.blocks.find((b: any) => b.type === 'header')!;
    expect(header.text.text).toContain('🚨');

    const section = message.blocks.find((b: any) => b.type === 'section')!;
    expect(section.text.text).toContain('sender@sendco.com');
    expect(section.text.text).toContain('zen.spamhaus.org');
    expect(section.text.text).toContain('bl.spamcop.net');
  });

  it('includes prev/current/delta for score_drop', () => {
    const message = formatSlackMessage({
      type: 'score_drop',
      inboxEmail: 'sender@sendco.com',
      inboxId: 'inbox-1',
      appUrl: 'https://app.emailwarm.io',
      payload: { prev: 80, current: 60, delta: 20 },
    });

    const section = message.blocks.find((b: any) => b.type === 'section')!;
    expect(section.text.text).toContain('80');
    expect(section.text.text).toContain('60');
    expect(section.text.text).toContain('20');
  });

  it('includes the recommended send volume for warmup_complete', () => {
    const message = formatSlackMessage({
      type: 'warmup_complete',
      inboxEmail: 'sender@sendco.com',
      inboxId: 'inbox-1',
      appUrl: 'https://app.emailwarm.io',
      payload: { recommendedDailySendVolume: 80 },
    });

    const section = message.blocks.find((b: any) => b.type === 'section')!;
    expect(section.text.text).toContain('80');
    expect(message.blocks.find((b: any) => b.type === 'header')!.text.text).toContain('🎉');
  });

  it('includes a context block with a timestamp and dashboard link', () => {
    const message = formatSlackMessage({
      type: 'token_revoked',
      inboxEmail: 'sender@sendco.com',
      inboxId: 'inbox-1',
      appUrl: 'https://app.emailwarm.io',
      payload: {},
    });

    const context = message.blocks.find((b: any) => b.type === 'context')!;
    expect(context).toBeDefined();
    const contextText = context.elements[0].text;
    expect(contextText).toContain('https://app.emailwarm.io/inboxes/inbox-1');
  });
});
