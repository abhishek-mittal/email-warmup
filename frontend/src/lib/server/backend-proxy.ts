import 'server-only';
import { getAuth } from '../auth-server';
import { mintBearerToken } from '../bearer-token';

/**
 * The browser never talks to the API directly and never holds anything that
 * can sign a request (MR-07). It calls same-origin `/api/backend/*`; this
 * module validates the better-auth session on the server, derives the user
 * id from it, and forwards the request with a credential minted here.
 */

/** Credential lifetime: long enough for one forwarded request, nothing more. */
const INTERNAL_TOKEN_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
/** Largest request body forwarded. CSV imports are the biggest legitimate payload. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * API surface reachable from the browser: first path segment -> methods.
 * Anything else — `/internal/*`, `/webhooks/*`, `/health`, unknown paths — is
 * refused here regardless of what the API itself would do with it.
 */
const ALLOWED: Record<string, readonly Method[]> = {
  inboxes: ['GET', 'POST'],
  'pool-inboxes': ['GET', 'POST', 'DELETE'],
  // Mailbox-link start only. The link callback is completed by this server's
  // own /api/mailbox-oauth route, never by the browser directly.
  auth: ['GET'],
  billing: ['GET', 'POST'],
  // Data export and account deletion.
  account: ['GET', 'POST'],
};

const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'cache-control'];

export function serverApiUrl(): string {
  return (
    process.env.API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:4611'
  ).replace(/\/+$/, '');
}

function json(status: number, message: string, code?: string): Response {
  return Response.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });
}

/** Rejects traversal, encoded separators and anything that isn't a plain path segment. */
export function isSafeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false;
  return /^[A-Za-z0-9._~-]+$/.test(segment);
}

export function isAllowedTarget(method: string, segments: string[]): boolean {
  if (segments.length === 0 || !segments.every(isSafeSegment)) return false;
  const methods = ALLOWED[segments[0]];
  return Boolean(methods && methods.includes(method as Method));
}

/**
 * Cookie-authenticated mutations must come from this site. Browsers send
 * Origin on every cross-origin request and on same-origin non-GET requests,
 * so a state-changing request whose Origin is missing or foreign is refused.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set<string>([new URL(req.url).origin]);
  for (const configured of [process.env.BETTER_AUTH_URL, process.env.APP_URL]) {
    if (configured) {
      try {
        allowed.add(new URL(configured).origin);
      } catch {
        // ignore a malformed configured URL
      }
    }
  }
  return allowed.has(origin);
}

/** The signed-in user for this request, validated against the session store. */
export async function sessionUserId(req: Request): Promise<string | null> {
  try {
    const session = await getAuth().api.getSession({
      headers: req.headers,
      // Skip the signed cookie cache so a revoked or signed-out session
      // stops working immediately rather than when the cache expires.
      query: { disableCookieCache: true },
    });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Calls the API as `userId`. The credential is created here and never leaves the server. */
export async function callBackend(
  userId: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: BodyInit | null },
): Promise<Response> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not configured');
  const token = await mintBearerToken(userId, secret, INTERNAL_TOKEN_TTL_MS);
  return fetch(`${serverApiUrl()}${path}`, {
    method: init.method,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
    body: init.body,
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

export async function proxyToBackend(req: Request, segments: string[]): Promise<Response> {
  const method = req.method.toUpperCase();
  if (!isAllowedTarget(method, segments)) {
    return json(404, 'Not found');
  }
  if (method !== 'GET' && !isSameOrigin(req)) {
    return json(403, 'Cross-origin request refused', 'bad_origin');
  }

  const userId = await sessionUserId(req);
  if (!userId) {
    return json(401, 'Not signed in', 'unauthenticated');
  }

  let body: ArrayBuffer | undefined;
  if (method !== 'GET') {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json(413, 'Request body too large');
    }
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return json(413, 'Request body too large');
    }
  }

  // Only these headers travel upstream. In particular the caller's own
  // Authorization, Cookie and any identity-looking header are dropped, so
  // nothing the browser sends can influence who the API thinks is calling.
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }

  const search = new URL(req.url).search;
  let upstream: Response;
  try {
    upstream = await callBackend(userId, `/${segments.join('/')}${search}`, {
      method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
    });
  } catch {
    return json(502, 'The service is temporarily unavailable', 'upstream_unavailable');
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has('cache-control')) responseHeaders.set('cache-control', 'no-store');
  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
