import { useMemo } from 'react';
import { createAuthClient } from 'better-auth/react';
import { mintBearerToken } from './bearer-token';

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`API ${status}: ${body}`);
    this.status = status;
    this.body = body;
    this.name = 'ApiError';
  }
}

export function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
}

const authClient = createAuthClient({
  baseURL:
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'),
});

/**
 * Resolve the current userId by hitting better-auth's /get-session
 * directly. This is a one-shot fetch — the result is fresh from the
 * server, not whatever happens to be in the better-auth session atom
 * cache (which can be stale or `isPending: true` right after a
 * hard-navigation in dev mode).
 *
 * Exposed so useApi and individual forms can call it when they need
 * an up-to-date userId. The session atom (authClient.useSession) is
 * fine for *rendering* the user's name/email in the topbar, but for
 * deriving an auth token for an API call we want a live read.
 */
export async function getCurrentUserId(): Promise<string | null> {
  try {
    const session = await authClient.getSession();
    return session?.data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Hook that returns an authenticated API caller. Mints a short-lived
 * HMAC-signed token from the active better-auth session and sends it as
 * `Authorization: Bearer <token>`. Backend verifies the HMAC against the
 * shared BETTER_AUTH_SECRET — no DB lookup needed.
 *
 * Each call to the returned function re-fetches the current userId via
 * a fresh get-session, so a hard-navigation in dev mode (where the
 * session atom may briefly hold `isPending: true`) doesn't accidentally
 * submit a request without a Bearer.
 */
export function useApi() {
  // We deliberately don't subscribe to useSession() here — its atom can
  // be stale across hard navigations, and the topbar already shows the
  // user. For each API call we just re-resolve the userId fresh.
  return useMemo(() => {
    return async function api<T = unknown>(
      path: string,
      init?: RequestInit,
    ): Promise<T> {
      let token: string | null = null;
      const userId = await getCurrentUserId();
      const secret = process.env.NEXT_PUBLIC_BETTER_AUTH_SECRET;
      if (userId && secret) {
        try {
          token = await mintBearerToken(userId, secret);
        } catch {
          token = null;
        }
      }

      // When the body is a FormData (multipart upload), don't set
      // Content-Type at all — fetch/the browser will set it automatically
      // with the correct multipart boundary. Setting it ourselves (even to
      // the default 'application/json') breaks the upload, since the
      // backend can no longer parse the multipart parts without a boundary.
      const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
      const headers: Record<string, string> = {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(init?.headers as Record<string, string> | undefined),
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const res = await fetch(`${getApiUrl()}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
      });

      if (!res.ok) {
        let body = '';
        try {
          body = await res.text();
        } catch {
          body = res.statusText;
        }
        throw new ApiError(res.status, body);
      }

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    };
  }, []);
}
