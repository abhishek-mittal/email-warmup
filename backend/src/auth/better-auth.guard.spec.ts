import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac } from 'crypto';
import { BetterAuthGuard } from './better-auth.guard';

function mintToken(userId: string, secret: string, ttlMs = 60_000): string {
  const exp = Date.now() + ttlMs;
  const u = Buffer.from(userId, 'utf8').toString('base64url');
  const e = Buffer.from(String(exp), 'utf8').toString('base64url');
  const payload = `v1.${u}.${e}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

describe('BetterAuthGuard', () => {
  let guard: BetterAuthGuard;
  let reflector: Reflector;
  const SECRET = 'test-secret-please-do-not-use-in-prod-32chars';

  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = SECRET;
  });

  afterAll(() => {
    delete process.env.BETTER_AUTH_SECRET;
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BetterAuthGuard, Reflector],
    }).compile();
    guard = module.get<BetterAuthGuard>(BetterAuthGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  function createContext(headers: Record<string, string> = {}) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;
  }

  it('allows public routes without token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createContext();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws when token is missing', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    await expect(guard.canActivate(createContext())).rejects.toThrow(UnauthorizedException);
  });

  it('throws when token is malformed', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    await expect(
      guard.canActivate(createContext({ authorization: 'Bearer not-a-jwt' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws when HMAC is wrong', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const tok = mintToken('user_123', 'wrong-secret');
    await expect(
      guard.canActivate(createContext({ authorization: `Bearer ${tok}` })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws when token is expired', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const tok = mintToken('user_123', SECRET, -1_000); // already expired
    await expect(
      guard.canActivate(createContext({ authorization: `Bearer ${tok}` })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches userId on valid token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const tok = mintToken('user_123', SECRET);
    const req: any = { headers: { authorization: `Bearer ${tok}` } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.userId).toBe('user_123');
  });

  it('fails closed when BETTER_AUTH_SECRET is unset', async () => {
    const old = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const tok = mintToken('user_123', SECRET);
      await expect(
        guard.canActivate(createContext({ authorization: `Bearer ${tok}` })),
      ).rejects.toThrow(UnauthorizedException);
    } finally {
      process.env.BETTER_AUTH_SECRET = old;
    }
  });
});
