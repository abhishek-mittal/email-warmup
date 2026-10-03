import 'server-only';
import { headers } from 'next/headers';
import { getAuth } from './auth-server';
import { mintBearerToken } from './bearer-token';

/**
 * Nest's default error body is JSON (`{statusCode, message, error}`), where
 * `message` is either a string or — for class-validator failures — a
 * string[]. Callers do `e.body` directly to show the user what went wrong,
 * so `body` holds this extracted, human-readable text rather than the raw
 * response text. Falls back to the raw text unchanged when it isn't JSON or
 * has no `message` field.
 */
function extractErrorMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      const { message } = parsed as { message: unknown };
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join(', ');
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return rawBody;
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    const message = extractErrorMessage(body);
    super(`API ${status}: ${message}`);
    this.status = status;
    this.body = message;
    this.name = 'ApiError';
  }
}

function getApiUrl(): string {
  return (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4611').replace(
    /\/+$/,
    '',
  );
}

/**
 * Server-side authenticated API caller. Reads the better-auth session from
 * the current request's cookies via `getAuth().api.getSession`, then mints
 * a short-lived HMAC-signed token to forward to the backend in
 * `Authorization: Bearer`.
 */
export async function serverApi<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;

  const hdrs: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (userId) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret) {
      hdrs.Authorization = `Bearer ${await mintBearerToken(userId, secret, 60_000)}`;
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
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}