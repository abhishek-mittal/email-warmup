import { describe, it, expect } from 'vitest';
import { errorHint, ZOHO_REGIONS, PROVIDER_PRESETS } from '../SmtpFormHints';

describe('errorHint — Zoho-specific guidance', () => {
  it('points IMAP login failures on a zoho host at the IMAP-access toggle', () => {
    const hint = errorHint('IMAP_EAUTH', 'imap.zoho.com', 993);
    expect(hint).toContain('IMAP Access');
    expect(hint).toContain('app-specific password');
    expect(hint).toContain('data center');
  });

  it('treats SMTP auth failures on a regional zoho host the same way', () => {
    const hint = errorHint('EAUTH', 'smtp.zoho.eu', 587);
    expect(hint).toContain('IMAP Access');
  });

  it('does NOT hijack auth failures for non-zoho hosts', () => {
    const hint = errorHint('EAUTH', 'smtp.gmail.com', 587);
    expect(hint).not.toContain('IMAP Access');
    expect(hint).toContain('App Password');
  });

  it('still returns null for unknown codes', () => {
    expect(errorHint('WHATEVER', 'imap.zoho.com', 993)).toBeNull();
    expect(errorHint(null)).toBeNull();
  });
});

describe('ZOHO_REGIONS', () => {
  it('covers every documented data center with matching smtp/imap suffixes and standard ports', () => {
    expect(ZOHO_REGIONS.length).toBeGreaterThanOrEqual(7);
    for (const region of ZOHO_REGIONS) {
      expect(region.config.smtpHost.startsWith('smtp.')).toBe(true);
      expect(region.config.imapHost.startsWith('imap.')).toBe(true);
      // Same domain suffix on both transports for a given DC.
      expect(region.config.smtpHost.replace(/^smtp\./, '')).toBe(
        region.config.imapHost.replace(/^imap\./, ''),
      );
      expect(region.config.smtpPort).toBe(587);
      expect(region.config.imapPort).toBe(993);
    }
  });

  it('defaults (US/Global) match the base Zoho preset', () => {
    const us = ZOHO_REGIONS.find((r) => r.key === 'com');
    expect(us?.config).toEqual(PROVIDER_PRESETS.zoho);
  });

  it('has unique hosts and keys', () => {
    const keys = ZOHO_REGIONS.map((r) => r.key);
    const hosts = ZOHO_REGIONS.map((r) => r.config.smtpHost);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
