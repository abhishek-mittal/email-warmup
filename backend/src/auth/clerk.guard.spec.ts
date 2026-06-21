import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClerkGuard } from './clerk.guard';
import * as clerkBackend from '@clerk/backend';

jest.mock('@clerk/backend', () => ({
  verifyToken: jest.fn(),
}));

describe('ClerkGuard', () => {
  let guard: ClerkGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ClerkGuard, Reflector],
    }).compile();
    guard = module.get<ClerkGuard>(ClerkGuard);
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
    await expect(guard.canActivate(createContext())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws when token is invalid', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (clerkBackend.verifyToken as jest.Mock).mockRejectedValue(new Error('bad'));
    await expect(
      guard.canActivate(createContext({ authorization: 'Bearer fake' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches userId on valid token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (clerkBackend.verifyToken as jest.Mock).mockResolvedValue({ sub: 'user_123' });
    const req: any = { headers: { authorization: 'Bearer valid' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.userId).toBe('user_123');
  });
});
