import { grantsGmailMailScope, GMAIL_MAIL_SCOPE } from './mailbox-link.service';

describe('grantsGmailMailScope', () => {
  it('true when the full-mail scope is present among granted scopes', () => {
    expect(grantsGmailMailScope(`openid email ${GMAIL_MAIL_SCOPE}`)).toBe(true);
  });

  it('false when only email/openid were granted (the real failure case)', () => {
    expect(
      grantsGmailMailScope('https://www.googleapis.com/auth/userinfo.email openid'),
    ).toBe(false);
  });

  it('false for empty / undefined / null', () => {
    expect(grantsGmailMailScope('')).toBe(false);
    expect(grantsGmailMailScope(undefined)).toBe(false);
    expect(grantsGmailMailScope(null)).toBe(false);
  });

  it('does not match a mere prefix', () => {
    expect(grantsGmailMailScope('https://mail.google.com')).toBe(false);
  });
});
