import { Test, TestingModule } from '@nestjs/testing';
import { ImapClientService, ImapNotConfiguredError } from './imap-client.service';
import { GoogleOAuthService } from '../oauth/google-oauth.service';
import { MicrosoftOAuthService } from '../oauth/microsoft-oauth.service';
import { db } from '../../db';

import { pinoLoggerStubsFor } from '../../common/test-module';
jest.mock('../../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

// Encrypted credentials are decrypted via common/crypto before use. Mocked
// here (like other specs mock `db`) rather than depending on a real
// ENCRYPTION_KEY at module-eval time.
jest.mock('../../common/crypto', () => ({
  decrypt: jest.fn((ciphertext: string) => `decrypted:${ciphertext}`),
  encrypt: jest.fn((plaintext: string) => `encrypted:${plaintext}`),
}));

const connectMock = jest.fn().mockResolvedValue(undefined);
const logoutMock = jest.fn().mockResolvedValue(undefined);

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts: any) => ({
    usable: true,
    connect: connectMock,
    logout: logoutMock,
    __opts: opts,
  })),
}));

describe('ImapClientService', () => {
  let service: ImapClientService;
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
    connectMock.mockResolvedValue(undefined);

    googleOAuthService = { refreshToken: jest.fn() };
    microsoftOAuthService = { refreshToken: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [...pinoLoggerStubsFor(ImapClientService, ImapNotConfiguredError, GoogleOAuthService, MicrosoftOAuthService, db),
      
        ImapClientService,
        { provide: GoogleOAuthService, useValue: googleOAuthService },
        { provide: MicrosoftOAuthService, useValue: microsoftOAuthService },
      ],
    }).compile();

    service = module.get<ImapClientService>(ImapClientService);
  });

  describe('getConnection (inboxes table — unchanged path)', () => {
    it('connects using custom IMAP credentials', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@custom.com',
        provider: 'custom',
        imapHost: 'imap.custom.com',
        imapPort: 993,
        imapUser: 'user@custom.com',
        imapPass: 'ciphertext-pass',
      });

      const client = await service.getConnection('inbox-1');

      expect(client).toBeTruthy();
      expect(connectMock).toHaveBeenCalled();
    });

    it('throws ImapNotConfiguredError when imapHost is missing', async () => {
      mockSelectInbox({ id: 'inbox-1', email: 'user@custom.com', provider: 'custom' });

      await expect(service.getConnection('inbox-1')).rejects.toThrow(ImapNotConfiguredError);
    });

    it('reuses a pooled connection on the second call', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@custom.com',
        provider: 'custom',
        imapHost: 'imap.custom.com',
        imapPort: 993,
        imapUser: 'user@custom.com',
        imapPass: 'ciphertext-pass',
      });

      await service.getConnection('inbox-1');
      await service.getConnection('inbox-1');

      expect(connectMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPoolInboxConnection', () => {
    it('throws when the pool inbox cannot be found', async () => {
      mockSelectInbox(null);

      await expect(service.getPoolInboxConnection('pi-1')).rejects.toThrow('Pool inbox not found');
    });

    it('builds an ImapFlow client from custom credentials in encrypted_credentials', async () => {
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

      const client: any = await service.getPoolInboxConnection('pi-1');

      expect(connectMock).toHaveBeenCalled();
      expect(client.__opts.host).toBe('imap.custom.com');
      expect(client.__opts.auth.user).toBe('user@custom.com');
      expect(client.__opts.auth.pass).toBe('decrypted:enc-imap-pass');
    });

    it('throws ImapNotConfiguredError when custom credentials are incomplete', async () => {
      mockSelectInbox({
        id: 'pi-1',
        provider: 'custom',
        encryptedCredentials: { imapHost: 'imap.custom.com' },
      });

      await expect(service.getPoolInboxConnection('pi-1')).rejects.toThrow(ImapNotConfiguredError);
    });

    it('mints a fresh access token via GoogleOAuthService.refreshToken for a gmail pool inbox', async () => {
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

      const client: any = await service.getPoolInboxConnection('pi-1');

      expect(googleOAuthService.refreshToken).toHaveBeenCalledWith('decrypted:enc-refresh-token', {
        clientId: 'pool-client-id',
        clientSecret: 'decrypted:enc-client-secret',
      });
      expect(client.__opts.auth.accessToken).toBe('fresh-access-token');
      expect(client.__opts.auth.user).toBe('partner@gmail.com');
    });

    it('mints a fresh access token via MicrosoftOAuthService.refreshToken for an outlook pool inbox', async () => {
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

      const client: any = await service.getPoolInboxConnection('pi-1');

      expect(microsoftOAuthService.refreshToken).toHaveBeenCalledWith(
        'decrypted:enc-refresh-token',
        { clientId: 'pool-client-id', clientSecret: 'decrypted:enc-client-secret' },
      );
      expect(googleOAuthService.refreshToken).not.toHaveBeenCalled();
      expect(client.__opts.auth.accessToken).toBe('fresh-access-token-ms');
    });

    it('throws ImapNotConfiguredError when OAuth credentials are incomplete', async () => {
      mockSelectInbox({
        id: 'pi-1',
        email: 'partner@gmail.com',
        provider: 'gmail',
        encryptedCredentials: { clientId: 'pool-client-id' },
      });

      await expect(service.getPoolInboxConnection('pi-1')).rejects.toThrow(ImapNotConfiguredError);
    });

    it('keys pool connections separately from inbox connections (prefixed pool map key)', async () => {
      mockSelectInbox({
        id: 'pi-1',
        provider: 'custom',
        encryptedCredentials: {
          imapHost: 'imap.custom.com',
          imapPort: 993,
          imapUser: 'user@custom.com',
          imapPassword: 'enc-imap-pass',
        },
      });

      await service.getPoolInboxConnection('pi-1');
      await service.getPoolInboxConnection('pi-1');

      // Reused from the pool on the second call.
      expect(connectMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('closes a regular inbox connection', async () => {
      mockSelectInbox({
        id: 'inbox-1',
        email: 'user@custom.com',
        provider: 'custom',
        imapHost: 'imap.custom.com',
        imapPort: 993,
        imapUser: 'user@custom.com',
        imapPass: 'ciphertext-pass',
      });
      await service.getConnection('inbox-1');

      await service.close('inbox-1');

      expect(logoutMock).toHaveBeenCalled();
    });

    it('closes a pool inbox connection by its bare id', async () => {
      mockSelectInbox({
        id: 'pi-1',
        provider: 'custom',
        encryptedCredentials: {
          imapHost: 'imap.custom.com',
          imapPort: 993,
          imapUser: 'user@custom.com',
          imapPassword: 'enc-imap-pass',
        },
      });
      await service.getPoolInboxConnection('pi-1');

      await service.close('pi-1');

      expect(logoutMock).toHaveBeenCalled();
    });

    it('is a no-op when no connection exists for the given id', async () => {
      await expect(service.close('unknown-id')).resolves.toBeUndefined();
      expect(logoutMock).not.toHaveBeenCalled();
    });
  });
});
