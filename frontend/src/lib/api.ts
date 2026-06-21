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
 * Hook that returns an authenticated API caller. Mints a short-lived
 * HMAC-signed token from the active better-auth session and sends it as
 * `Authorization: Bearer <token>`. Backend verifies the HMAC against the
 * shared BETTER_AUTH_SECRET — no DB lookup needed.
 */
export function useApi() {
  return async function api<T = unknown>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    let token: string | null = null;
    try {
      const session = await authClient.getSession();
      const userId = session?.data?.user?.id;
      const secret = process.env.NEXT_PUBLIC_BETTER_AUTH_SECRET;
      if (userId && secret) {
        token = await mintBearerToken(userId, secret);
      }
    } catch {
      token = null;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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
}