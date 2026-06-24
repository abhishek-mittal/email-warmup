import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { UserSyncService } from './user-sync.service';

const SECRET = 'test-internal-secret-please-do-not-use-1234567890';

describe('InternalController', () => {
  let controller: InternalController;
  let userSync: { upsertUser: jest.Mock };

  beforeAll(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });

  afterAll(() => {
    delete process.env.INTERNAL_SECRET;
  });

  beforeEach(async () => {
    userSync = { upsertUser: jest.fn().mockResolvedValue({ created: true }) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [{ provide: UserSyncService, useValue: userSync }],
    }).compile();
    controller = module.get<InternalController>(InternalController);
  });

  it('rejects requests with a missing X-Internal-Secret header', async () => {
    await expect(controller.syncUser({ id: 'u1', email: 'a@b.c' }, undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userSync.upsertUser).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong secret', async () => {
    await expect(
      controller.syncUser({ id: 'u1', email: 'a@b.c' }, 'definitely-wrong'),
    ).rejects.toThrow(UnauthorizedException);
    expect(userSync.upsertUser).not.toHaveBeenCalled();
  });

  it('rejects when lengths differ (constant-time-compare short-circuit is still a hard fail)', async () => {
    await expect(controller.syncUser({ id: 'u1', email: 'a@b.c' }, 'short')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userSync.upsertUser).not.toHaveBeenCalled();
  });

  it('rejects when id is missing', async () => {
    await expect(controller.syncUser({ email: 'a@b.c' }, SECRET)).rejects.toThrow(
      BadRequestException,
    );
    expect(userSync.upsertUser).not.toHaveBeenCalled();
  });

  it('rejects when email is missing', async () => {
    await expect(controller.syncUser({ id: 'u1' }, SECRET)).rejects.toThrow(BadRequestException);
    expect(userSync.upsertUser).not.toHaveBeenCalled();
  });

  it('calls userSync.upsertUser and returns created=true on a new user', async () => {
    const res = await controller.syncUser({ id: 'user_123', email: 'a@b.com' }, SECRET);
    expect(userSync.upsertUser).toHaveBeenCalledWith({
      id: 'user_123',
      email: 'a@b.com',
    });
    expect(res).toEqual({ ok: true, created: true });
  });

  it('returns created=false on subsequent calls (idempotent upsert)', async () => {
    userSync.upsertUser.mockResolvedValueOnce({ created: false });
    const res = await controller.syncUser({ id: 'user_123', email: 'a@b.com' }, SECRET);
    expect(res).toEqual({ ok: true, created: false });
  });

  it('fails closed when INTERNAL_SECRET env var is unset (no env, never accepts)', async () => {
    const old = process.env.INTERNAL_SECRET;
    delete process.env.INTERNAL_SECRET;
    try {
      await expect(controller.syncUser({ id: 'u1', email: 'a@b.c' }, 'anything')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(userSync.upsertUser).not.toHaveBeenCalled();
    } finally {
      process.env.INTERNAL_SECRET = old;
    }
  });
});
