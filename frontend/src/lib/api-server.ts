import 'server-only';
import { headers } from 'next/headers';
import { auth } from './auth-server';
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

function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
}

/**
 * Server-side authenticated API caller. Reads the better-auth session from
 * the current request's cookies via `auth.api.getSession`, then mints a
 * short-lived HMAC-signed token to forward to the backend in
 * `Authorization: Bearer`.
 */
export async function serverApi<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;

  const hdrs: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (userId) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret) {
      hdrs.Authorization = `Bearer ${await mintBearerToken(userId, secret)}`;
    }
  }

  const res = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: hdrs,
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
}

/**
 * Returns the current user id, or null if not signed in. Use in Server
 * Components that need to gate rendering on auth.
 */
export async function currentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}