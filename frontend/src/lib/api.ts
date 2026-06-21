'use client';

import { useAuth } from '@clerk/nextjs';

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

/**
 * Hook that returns an authenticated API caller. The returned function injects
 * the Clerk session token as `Authorization: Bearer <token>` and parses JSON.
 *
 * Use in Client Components only. For Server Components, call
 * `serverApi(token, ...)` from `src/lib/api-server.ts`.
 */
export function useApi() {
  const { getToken } = useAuth();

  return async function api<T = unknown>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    let token: string | null = null;
    try {
      token = await getToken();
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
