import { UserSyncService } from './user-sync.service';
import { db } from '../db';
import { users } from '../db/schema';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

describe('UserSyncService.upsertUser (T024)', () => {
  let service: UserSyncService;

  function mockSelectExisting(existing: unknown[]) {
    const limit = jest.fn().mockResolvedValue(existing);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    (db.select as jest.Mock).mockReturnValue({ from });
  }

  function mockInsert() {
    // service code: await db.insert(users).values({...}) — the final
    // call is `.values({...})` which must return a thenable; we don't
    // care about its return shape.
    const values = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values });
    (db.insert as jest.Mock).mockImplementation(insert);
    return { insert, values };
  }

  function mockUpdate() {
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    (db.update as jest.Mock).mockReturnValue({ set });
  }

  beforeEach(() => {
    service = new UserSyncService();
    jest.clearAllMocks();
  });

  it('inserts a new user when no row exists and reports created=true', async () => {
    mockSelectExisting([]);
    const { insert, values } = mockInsert();
    const res = await service.upsertUser({ id: 'u1', email: 'a@b.com' });
    expect(insert).toHaveBeenCalledWith(users);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'u1',
        email: 'a@b.com',
        plan: 'trial',
      }),
    );
    // 7 days from now
    const call = values.mock.calls[0][0];
    const diff = call.trialEndsAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(7.01 * 24 * 60 * 60 * 1000);
    expect(res).toEqual({ created: true });
  });

  it('updates an existing user (no insert) and reports created=false (idempotent)', async () => {
    mockSelectExisting([{ id: 'u1', email: 'old@b.com', plan: 'growth' }]);
    mockUpdate();
    const res = await service.upsertUser({ id: 'u1', email: 'new@b.com' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ created: false });
  });

  it('preserves the existing plan on update when no plan is passed in', async () => {
    mockSelectExisting([{ id: 'u1', email: 'a@b.com', plan: 'agency' }]);
    const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    (db.update as jest.Mock).mockReturnValue({ set });
    await service.upsertUser({ id: 'u1', email: 'a@b.com' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.com', plan: 'agency' }));
  });

  it('honors an explicit plan override on update', async () => {
    mockSelectExisting([{ id: 'u1', email: 'a@b.com', plan: 'agency' }]);
    const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    (db.update as jest.Mock).mockReturnValue({ set });
    await service.upsertUser({ id: 'u1', email: 'a@b.com', plan: 'starter' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ plan: 'starter' }));
  });
});
