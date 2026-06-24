import { timingSafeEqual } from 'crypto';

export interface UserCreatedPayload {
  id: string;
  email: string;
}

export interface SyncUserOptions {
  apiUrl: string;
  secret: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  logger?: { error: (msg: string, ...args: unknown[]) => void };
}

const defaultLogger = {
  error: (msg: string, ...args: unknown[]) =>
    console.error('[user-sync] ' + msg, ...args),
};

/**
 * Fires after a better-auth `user` row is created. POSTs the
 * `{id,email}` to the backend's `/internal/user-sync` with the shared
 * `X-Internal-Secret` so the backend can create the matching row in its
 * own `users` table (with `plan='trial'` and a 7-day trial).
 *
 * Errors are logged, never thrown — better-auth's user-creation flow
 * must not fail because the sync call failed (the user is already
 * signed in; their next authenticated request would still 403, but
 * that's preferable to breaking the signup itself). A retry/backoff
 * job is a reasonable future addition but is out of scope for T024.
 */
export async function syncUserToBackend(
  user: UserCreatedPayload,
  opts: SyncUserOptions,
): Promise<{ ok: boolean; status: number }> {
  const log = opts.logger ?? defaultLogger;
  const doFetch = opts.fetchImpl ?? fetch;

  if (!opts.apiUrl || !opts.secret) {
    log.error('INTERNAL_SECRET or NEXT_PUBLIC_API_URL unset — skipping user sync');
    return { ok: false, status: 0 };
  }

  const url = `${opts.apiUrl.replace(/\/+$/, '')}/internal/user-sync`;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': opts.secret,
      },
      body: JSON.stringify({ id: user.id, email: user.email }),
    });
    if (!res.ok) {
      log.error('user-sync non-2xx', { status: res.status, userId: user.id });
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    log.error('user-sync fetch failed', { userId: user.id, err });
    return { ok: false, status: 0 };
  }
}

/**
 * Constant-time equality on two non-empty strings. Exposed for tests
 * that want to assert the hook builds a request the backend will
 * accept, without actually calling the backend.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
