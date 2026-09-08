import { Test, TestingModule } from '@nestjs/testing';
import { SmtpClientService } from './smtp-client.service';
import { GoogleOAuthService } from '../oauth/google-oauth.service';
import { MicrosoftOAuthService } from '../oauth/microsoft-oauth.service';
import { db } from '../../db';

import { pinoLoggerStubsFor } from '../../common/test-module';
jest.mock('../../db', () => ({
  db: {
    select: jest.fn(),
  },
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
  let googleOAuthService: { refreshToken: jest.Mock };
  let microsoftOAuthService: { refreshToken: jest.Mock };

  function mockSelectInbox(row: any) {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(row ? [row] : []),
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    googleOAuthService = { refreshToken: jest.fn() };
    microsoftOAuthService = { refreshToken: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(SmtpClientService, GoogleOAuthService, MicrosoftOAuthService, db),

        SmtpClientService,
        { provide: GoogleOAuthService, useValue: googleOAuthService },
        { provide: MicrosoftOAuthService, useValue: microsoftOAuthService },
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

      expect(transporter.__opts.auth.accessToken).toBe('decrypted:enc-access-token');
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

      expect(transporter.__opts.host).toBe('smtp.custom.com');
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

    it('decrypts clientSecret and refreshToken, then mints a fresh access token via GoogleOAuthService for a gmail pool inbox', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@gmail.com',
        provider: 'gmail',
        encryptedCredentials: {
          clientId: 'pool-client-id',
          clientSecret: 'enc-client-secret',
          refreshToken: 'enc-refresh-token',
        },
      });
      googleOAuthService.refreshToken.mockResolvedValue({
        access_token: 'fresh-access-token',
        expires_in: 3600,
      });

      const transporter: any = await service.getPoolInboxTransporter('pi-1');

      expect(googleOAuthService.refreshToken).toHaveBeenCalledWith('decrypted:enc-refresh-token', {
        clientId: 'pool-client-id',
        clientSecret: 'decrypted:enc-client-secret',
      });
      expect(transporter.__opts.auth.accessToken).toBe('fresh-access-token');
      expect(transporter.__opts.auth.user).toBe('partner@gmail.com');
    });

    it('decrypts clientSecret and refreshToken, then mints a fresh access token via MicrosoftOAuthService for an outlook pool inbox', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@outlook.com',
        provider: 'outlook',
        encryptedCredentials: {
          clientId: 'pool-client-id',
          clientSecret: 'enc-client-secret',
          refreshToken: 'enc-refresh-token',
        },
      });
      microsoftOAuthService.refreshToken.mockResolvedValue({
        access_token: 'fresh-access-token-ms',
        expires_in: 3600,
      });

      const transporter: any = await service.getPoolInboxTransporter('pi-1');

      expect(microsoftOAuthService.refreshToken).toHaveBeenCalledWith(
        'decrypted:enc-refresh-token',
        { clientId: 'pool-client-id', clientSecret: 'decrypted:enc-client-secret' },
      );
      expect(googleOAuthService.refreshToken).not.toHaveBeenCalled();
      expect(transporter.__opts.auth.accessToken).toBe('fresh-access-token-ms');
    });

    it('throws when OAuth credentials are incomplete', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@gmail.com',
        provider: 'gmail',
        encryptedCredentials: { clientId: 'pool-client-id' },
      });

      await expect(service.getPoolInboxTransporter('pi-1')).rejects.toThrow();
    });
  });
});
