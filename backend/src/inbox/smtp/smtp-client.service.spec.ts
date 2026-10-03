import { Test, TestingModule } from '@nestjs/testing';
import { SmtpClientService } from './smtp-client.service';
import { MailCredentialService } from '../oauth/mail-credential.service';
import { db } from '../../db';

import { pinoLoggerStubsFor } from '../../common/test-module';
jest.mock('../../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

// DNS resolution and the address policy are covered in common/egress-policy.spec.ts
// and test/integration/safety.int-spec.ts; here hosts resolve to a fixed public address.
jest.mock('../../common/egress-policy', () => ({
  ...jest.requireActual('../../common/egress-policy'),
  resolvePublicHost: jest.fn(async (host: string) => ({
    address: '203.0.113.10',
    family: 4,
    servername: host,
  })),
}));

jest.mock('../../common/crypto', () => ({
  decrypt: jest.fn((ciphertext: string) => `decrypted:${ciphertext}`),
  encrypt: jest.fn((plaintext: string) => `encrypted:${plaintext}`),
}));

const createTransportMock = jest.fn((opts: any) => ({ __opts: opts, sendMail: jest.fn() }));

jest.mock('nodemailer', () => ({
  createTransport: (opts: any) => createTransportMock(opts),
}));

describe('SmtpClientService', () => {
  let service: SmtpClientService;
  let credentials: { getInboxAccessToken: jest.Mock; getPoolInboxAccessToken: jest.Mock };

  function mockSelectInbox(row: any) {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(row ? [row] : []),
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    credentials = {
      getInboxAccessToken: jest.fn().mockResolvedValue('inbox-access-token'),
      getPoolInboxAccessToken: jest.fn().mockResolvedValue('pool-access-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(SmtpClientService, MailCredentialService, db),

        SmtpClientService,
        { provide: MailCredentialService, useValue: credentials },
      ],
    }).compile();

    service = module.get<SmtpClientService>(SmtpClientService);
  });

  describe('getTransporter (inboxes table — unchanged path)', () => {
    it('builds an OAuth2 transporter for a gmail inbox', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@gmail.com',
        provider: 'gmail',
        oauthAccessToken: 'enc-access-token',
      });

      const transporter: any = await service.getTransporter('inbox-1');

      expect(credentials.getInboxAccessToken).toHaveBeenCalledWith('inbox-1');
      expect(transporter.__opts.auth.accessToken).toBe('inbox-access-token');
      // Gmail: implicit TLS on 465.
      expect(transporter.__opts.host).toBe('smtp.gmail.com');
      expect(transporter.__opts.port).toBe(465);
      expect(transporter.__opts.secure).toBe(true);
    });

    it('uses STARTTLS on 587 for an outlook inbox, never implicit TLS', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@outlook.com',
        provider: 'outlook',
        smtpHost: 'smtp.office365.com',
        smtpPort: 587,
      });

      const transporter: any = await service.getTransporter('inbox-1');

      expect(transporter.__opts.port).toBe(587);
      expect(transporter.__opts.secure).toBe(false);
      expect(transporter.__opts.requireTLS).toBe(true);
    });

    it('requires STARTTLS for a custom inbox on a non-465 port', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@custom.com',
        provider: 'custom',
        smtpHost: 'smtp.custom.com',
        smtpPort: 587,
        smtpUser: 'user@custom.com',
        smtpPass: 'enc-smtp-pass',
      });

      const transporter: any = await service.getTransporter('inbox-1');

      expect(transporter.__opts.secure).toBe(false);
      expect(transporter.__opts.requireTLS).toBe(true);
    });

    it('builds a basic-auth transporter for a custom inbox', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@custom.com',
        provider: 'custom',
        smtpHost: 'smtp.custom.com',
        smtpPort: 587,
        smtpUser: 'user@custom.com',
        smtpPass: 'enc-smtp-pass',
      });

      const transporter: any = await service.getTransporter('inbox-1');

      expect(transporter.__opts.auth.pass).toBe('decrypted:enc-smtp-pass');
    });
  });

  describe('getPoolInboxTransporter', () => {
    it('throws when the pool inbox cannot be found', async () => {
      mockSelectInbox(null);

      await expect(service.getPoolInboxTransporter('pi-1')).rejects.toThrow('Pool inbox not found');
    });

    it('builds a basic-auth transporter from custom credentials in encrypted_credentials', async () => {
      mockSelectInbox({
        id: 'pi-1',
        provider: 'custom',
        encryptedCredentials: {
          smtpHost: 'smtp.custom.com',
          smtpPort: 587,
          smtpUser: 'user@custom.com',
          smtpPassword: 'enc-smtp-pass',
          imapHost: 'imap.custom.com',
          imapPort: 993,
          imapUser: 'user@custom.com',
          imapPassword: 'enc-imap-pass',
        },
      });

      const transporter: any = await service.getPoolInboxTransporter('pi-1');

      // Connects to the address that passed the policy; the name is kept for TLS only.
      expect(transporter.__opts.host).toBe('203.0.113.10');
      expect(transporter.__opts.tls.servername).toBe('smtp.custom.com');
      expect(transporter.__opts.auth.user).toBe('user@custom.com');
      expect(transporter.__opts.auth.pass).toBe('decrypted:enc-smtp-pass');
    });

    it('throws when custom SMTP credentials are incomplete', async () => {
      mockSelectInbox({
        id: 'pi-1',
        provider: 'custom',
        encryptedCredentials: { smtpHost: 'smtp.custom.com' },
      });

      await expect(service.getPoolInboxTransporter('pi-1')).rejects.toThrow();
    });

    it('gets the access token from the credential service for a gmail pool inbox (implicit TLS 465)', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@gmail.com',
        provider: 'gmail',
        encryptedCredentials: {
          clientId: 'client-id',
          clientSecret: 'enc-client-secret',
          refreshToken: 'enc-refresh-token',
        },
      });

      const transporter: any = await service.getPoolInboxTransporter('pi-1');

      expect(credentials.getPoolInboxAccessToken).toHaveBeenCalledWith('pi-1');
      expect(transporter.__opts.auth.accessToken).toBe('pool-access-token');
      expect(transporter.__opts.auth.user).toBe('partner@gmail.com');
      expect(transporter.__opts.host).toBe('smtp.gmail.com');
      expect(transporter.__opts.port).toBe(465);
      expect(transporter.__opts.secure).toBe(true);
    });

    it('uses smtp.office365.com:587 with STARTTLS for an outlook pool inbox (not 465)', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@outlook.com',
        provider: 'outlook',
        encryptedCredentials: {
          clientId: 'client-id',
          clientSecret: 'enc-client-secret',
          refreshToken: 'enc-refresh-token',
        },
      });

      const transporter: any = await service.getPoolInboxTransporter('pi-1');

      expect(transporter.__opts.auth.accessToken).toBe('pool-access-token');
      expect(transporter.__opts.host).toBe('smtp.office365.com');
      expect(transporter.__opts.port).toBe(587);
      expect(transporter.__opts.secure).toBe(false);
      expect(transporter.__opts.requireTLS).toBe(true);
    });

    it('throws when OAuth credentials are incomplete', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@gmail.com',
        provider: 'gmail',
        encryptedCredentials: { clientId: 'pool-client-id' },
      });

      // The credential service owns this check; the transporter must surface its error.
      credentials.getPoolInboxAccessToken.mockRejectedValue(
        new Error('OAuth credentials missing for pool inbox pi-1'),
      );

      await expect(service.getPoolInboxTransporter('pi-1')).rejects.toThrow();
    });
  });
});
