import { Test, TestingModule } from '@nestjs/testing';
import { ImapClientService, ImapNotConfiguredError } from './imap-client.service';
import { MailCredentialService } from '../oauth/mail-credential.service';
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

const connectMock = jest.fn().mockResolvedValue(undefined);
const logoutMock = jest.fn().mockResolvedValue(undefined);

// Each mocked ImapFlow instance exposes a no-op `on()` so the production
// code's `client.on('error', …)` listener (added in 2026-06-24 to
// swallow unhandled IMAP socket errors that would otherwise crash the
// process — see imap-client.service.ts) doesn't throw in tests.
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts: any) => ({
    usable: true,
    connect: connectMock,
    logout: logoutMock,
    on: jest.fn(),
    __opts: opts,
  })),
}));

describe('ImapClientService', () => {
  let service: ImapClientService;
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
    connectMock.mockResolvedValue(undefined);

    credentials = {
      getInboxAccessToken: jest.fn().mockResolvedValue('inbox-access-token'),
      getPoolInboxAccessToken: jest.fn().mockResolvedValue('pool-access-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(ImapClientService, ImapNotConfiguredError, MailCredentialService, db),

        ImapClientService,
        { provide: MailCredentialService, useValue: credentials },
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
      expect(client.__opts.host).toBe('203.0.113.10');
      expect(client.__opts.servername).toBe('imap.custom.com');
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

    it.each([
      ['gmail', 'imap.gmail.com'],
      ['outlook', 'outlook.office365.com'],
    ])(
      'gets the access token from the credential service for a %s pool inbox',
      async (provider, host) => {
        mockSelectInbox({
          id: 'pi-1',
          email: `partner@${provider}.com`,
          provider,
          encryptedCredentials: {
            clientId: 'client-id',
            clientSecret: 'enc-client-secret',
            refreshToken: 'enc-refresh-token',
          },
        });

        const client: any = await service.getPoolInboxConnection('pi-1');

        expect(credentials.getPoolInboxAccessToken).toHaveBeenCalledWith('pi-1');
        expect(client.__opts.auth.accessToken).toBe('pool-access-token');
        expect(client.__opts.host).toBe(host);
        expect(client.__opts.port).toBe(993);
        expect(client.__opts.secure).toBe(true);
      },
    );

    it('connects an interactive gmail inbox that has no stored IMAP host (provider default)', async () => {
      mockSelectInbox({ id: 'inbox-g', email: 'user@gmail.com', provider: 'gmail' });

      const client: any = await service.getConnection('inbox-g');

      expect(credentials.getInboxAccessToken).toHaveBeenCalledWith('inbox-g');
      expect(client.__opts.host).toBe('imap.gmail.com');
      expect(client.__opts.port).toBe(993);
      expect(client.__opts.auth.accessToken).toBe('inbox-access-token');
    });

    it('runs work for one mailbox one caller at a time', async () => {
      mockSelectInbox({ id: 'inbox-s', email: 'user@gmail.com', provider: 'gmail' });
      const order: string[] = [];
      const slow = service.withInbox('inbox-s', async () => {
        order.push('a-start');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('a-end');
      });
      const fast = service.withInbox('inbox-s', async () => {
        order.push('b-start');
      });
      await Promise.all([slow, fast]);

      expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    });

    it('a failed task does not block the next one for that mailbox', async () => {
      mockSelectInbox({ id: 'inbox-f', email: 'user@gmail.com', provider: 'gmail' });
      await expect(
        service.withInbox('inbox-f', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(service.withInbox('inbox-f', async () => 'ok')).resolves.toBe('ok');
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
