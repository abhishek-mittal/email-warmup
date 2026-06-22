import { Test, TestingModule } from '@nestjs/testing';
import { MicrosoftOAuthService } from './microsoft-oauth.service';

describe('MicrosoftOAuthService', () => {
  let service: MicrosoftOAuthService;
  const originalFetch = global.fetch;
  const originalClientId = process.env.MICROSOFT_CLIENT_ID;
  const originalClientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  beforeEach(async () => {
    process.env.MICROSOFT_CLIENT_ID = 'platform-client-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'platform-client-secret';

    const module: TestingModule = await Test.createTestingModule({
      providers: [MicrosoftOAuthService],
    }).compile();
    service = module.get<MicrosoftOAuthService>(MicrosoftOAuthService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.MICROSOFT_CLIENT_ID = originalClientId;
    process.env.MICROSOFT_CLIENT_SECRET = originalClientSecret;
  });

  describe('refreshToken', () => {
    it('uses the platform client_id/client_secret when no override is given', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'tok-1', expires_in: 3600 }),
      });
      global.fetch = fetchMock as any;

      const result = await service.refreshToken('refresh-abc');

      expect(result).toEqual({ access_token: 'tok-1', expires_in: 3600 });
      const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
      expect(body.get('client_id')).toBe('platform-client-id');
      expect(body.get('client_secret')).toBe('platform-client-secret');
      expect(body.get('refresh_token')).toBe('refresh-abc');
    });

    it('uses the override client_id/client_secret when provided (pool-inbox OAuth app)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'tok-2', expires_in: 1800 }),
      });
      global.fetch = fetchMock as any;

      const result = await service.refreshToken('refresh-xyz', {
        clientId: 'pool-client-id',
        clientSecret: 'pool-client-secret',
      });

      expect(result).toEqual({ access_token: 'tok-2', expires_in: 1800 });
      const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
      expect(body.get('client_id')).toBe('pool-client-id');
      expect(body.get('client_secret')).toBe('pool-client-secret');
      expect(body.get('client_id')).not.toBe('platform-client-id');
    });

    it('throws BadRequestException when the token endpoint returns an error', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token expired' }),
      });
      global.fetch = fetchMock as any;

      await expect(service.refreshToken('refresh-bad')).rejects.toThrow('Token expired');
    });
  });
});
