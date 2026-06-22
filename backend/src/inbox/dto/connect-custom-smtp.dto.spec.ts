import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { normalizeAliases } from './connect-custom-smtp.dto';

describe('ConnectCustomSmtpDto (via normalizeAliases)', () => {
  function validate(payload: Record<string, unknown>) {
    return validateSync(normalizeAliases(payload));
  }

  describe('field name aliases', () => {
    it('accepts smtpPassword as an alias for smtpPass', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPassword: 'secret', // form uses this name
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts smtpPass as the canonical name', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret', // canonical
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts imapPassword as an alias for imapPass when useImap is true', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPassword: 'secret',
        useImap: true,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapUser: 'user',
        imapPassword: 'imapsecret', // form uses this name
      });
      expect(errors).toHaveLength(0);
    });

    it('still requires the SMTP fields to be non-empty when only the alias is given', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPassword: '', // empty alias should still fail
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'smtpPass')).toBe(true);
    });

    it('canonical smtpPass wins when both canonical and alias are present', () => {
      const dto = normalizeAliases({
        smtpPass: 'real-secret',
        smtpPassword: 'stale-alias',
      });
      expect(dto.smtpPass).toBe('real-secret');
    });
  });

  describe('IMAP optionality', () => {
    it('accepts a payload with no IMAP block at all (useImap omitted)', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret',
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts a payload with useImap=false (no IMAP block)', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret',
        useImap: false,
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects useImap=true with missing IMAP fields', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret',
        useImap: true,
      });
      const imapErrors = errors.filter((e) => e.property?.startsWith('imap'));
      expect(imapErrors.length).toBeGreaterThanOrEqual(4);
    });

    it('rejects useImap=true with only some IMAP fields', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret',
        useImap: true,
        imapHost: 'imap.example.com',
        imapPort: 993,
      });
      const missingFields = errors
        .filter((e) => e.property?.startsWith('imap'))
        .map((e) => e.property);
      expect(missingFields).toEqual(expect.arrayContaining(['imapUser', 'imapPass']));
    });
  });

  describe('port validation', () => {
    it('rejects an SMTP port outside 25/465/587', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 2525,
        smtpUser: 'user',
        smtpPass: 'secret',
      });
      expect(errors.some((e) => e.property === 'smtpPort')).toBe(true);
    });

    it('rejects an IMAP port outside 143/993', () => {
      const errors = validate({
        email: 'user@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret',
        useImap: true,
        imapHost: 'imap.example.com',
        imapPort: 1430,
        imapUser: 'user',
        imapPass: 'x',
      });
      expect(errors.some((e) => e.property === 'imapPort')).toBe(true);
    });
  });
});
