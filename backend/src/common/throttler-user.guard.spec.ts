import 'reflect-metadata';
import { UserThrottlerGuard } from './throttler-user.guard';

/**
 * MR-11: rate limits are keyed per authenticated user, falling back to the
 * client IP for unauthenticated requests. getTracker is protected, so the
 * test subclass exposes it.
 */
class TestableGuard extends UserThrottlerGuard {
  callGetTracker(req: Record<string, any>) {
    return this.getTracker(req);
  }
}

describe('UserThrottlerGuard.getTracker', () => {
  // The guard only uses the storage/options at request time, not in getTracker,
  // so constructing it with empty collaborators is safe for this unit.
  const guard = new TestableGuard({} as any, {} as any, {} as any);

  it('keys on userId when the request is authenticated', async () => {
    await expect(guard.callGetTracker({ userId: 'user-1', ip: '1.2.3.4' })).resolves.toBe('user-1');
  });

  it('falls back to the client IP when there is no userId', async () => {
    await expect(guard.callGetTracker({ ip: '1.2.3.4' })).resolves.toBe('1.2.3.4');
  });

  it('falls back to a constant when neither userId nor IP is present', async () => {
    await expect(guard.callGetTracker({})).resolves.toBe('anonymous');
  });
});
