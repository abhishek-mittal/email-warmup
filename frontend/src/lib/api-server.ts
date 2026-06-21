import { auth } from '@clerk/nextjs/server';

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
 * Server-side authenticated API caller. Use in Server Components where
 * `useAuth()` is unavailable.
 */
export async function serverApi<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();

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
}
