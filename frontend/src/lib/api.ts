import { useMemo } from 'react';

/**
 * Nest's default error body is JSON (`{statusCode, message, error}`), where
 * `message` is either a string or — for class-validator failures — a
 * string[]. Every call site across the app does `e.body` directly to show
 * the user what went wrong, so `body` holds this extracted, human-readable
 * text rather than the raw response text. Falls back to the raw text
 * unchanged when it isn't JSON or has no `message` field.
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

/**
 * Same-origin path prefix for API calls from the browser. The Next.js server
 * validates the session there and forwards the call; the browser holds no
 * credential for the API and cannot choose who it is calling as.
 */
const API_PROXY_PREFIX = '/api/backend';

/**
 * Hook that returns an API caller for client components. Requests go to the
 * same-origin proxy with the session cookie; there is no token in the
 * browser to mint, store or leak.
 */
export function useApi() {
  return useMemo(() => {
    return async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
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
      // Never let a caller-supplied Authorization header travel anywhere.
      delete headers.Authorization;
      delete headers.authorization;

      const res = await fetch(`${API_PROXY_PREFIX}${path}`, {
        ...init,
        headers,
        credentials: 'same-origin',
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
