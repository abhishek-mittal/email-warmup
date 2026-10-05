import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const getSession = vi.fn();
vi.mock('../../auth-server', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import {
  MAX_BODY_BYTES,
  isAllowedTarget,
  isSafeSegment,
  isSameOrigin,
  proxyToBackend,
} from '../backend-proxy';

const SECRET = 'unit-test-signing-secret-32-characters!!';
const ORIGIN = 'https://app.example.test';

function request(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Request {
  return new Request(`${ORIGIN}/api/backend/${path}`, init);
}

/** Verifies a forwarded credential exactly the way the API's guard does. */
function verify(authorization: string | null): { userId: string; exp: number } | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const [version, user, exp, sig] = authorization.slice(7).split('.');
  const expected = createHmac('sha256', SECRET).update(`${version}.${user}.${exp}`).digest('base64url');
  if (sig !== expected) return null;
  return {
    userId: Buffer.from(user, 'base64url').toString('utf8'),
    exp: Number(Buffer.from(exp, 'base64url').toString('utf8')),
  };
}

describe('backend proxy (MR-07)', () => {
  let upstream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    process.env.API_URL = 'http://api.internal:4611';
    delete process.env.BETTER_AUTH_URL;
    delete process.env.APP_URL;
    getSession.mockReset();
    getSession.mockResolvedValue({ user: { id: 'user-a' } });
    upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function forwarded(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    return { url, init };
  }

  it('forwards a signed-in request as the session user, with a short-lived credential', async () => {
    const res = await proxyToBackend(request('inboxes?limit=5'), ['inboxes']);

    expect(res.status).toBe(200);
    const { url, init } = forwarded();
    expect(url).toBe('http://api.internal:4611/inboxes?limit=5');
    const token = verify(init.headers.Authorization);
    expect(token?.userId).toBe('user-a');
    expect(token!.exp - Date.now()).toBeLessThanOrEqual(60_000);
    expect(token!.exp).toBeGreaterThan(Date.now());
  });

  it('validates the session against the store, not the cookie cache', async () => {
    await proxyToBackend(request('inboxes'), ['inboxes']);
    expect(getSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true } }),
    );
  });

  it.each([
    ['no session', null],
    ['a session without a user', {}],
  ])('answers 401 and calls nothing upstream with %s', async (_name, session) => {
    getSession.mockResolvedValue(session);
    const res = await proxyToBackend(request('inboxes'), ['inboxes']);
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 401 when the session lookup itself fails (revoked / malformed cookie)', async () => {
    getSession.mockRejectedValue(new Error('invalid session token'));
    const res = await proxyToBackend(request('inboxes'), ['inboxes']);
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('ignores every caller-supplied identity: Authorization, cookies, user-id headers and body', async () => {
    const res = await proxyToBackend(
      request('inboxes/connect/smtp', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: 'Bearer forged.token.for.user-b',
          cookie: 'session=whatever',
          'x-user-id': 'user-b',
          'x-internal-secret': 'guess',
        },
        body: JSON.stringify({ userId: 'user-b', email: 'a@b.test' }),
      }),
      ['inboxes', 'connect', 'smtp'],
    );

    expect(res.status).toBe(200);
    const { init } = forwarded();
    expect(verify(init.headers.Authorization)?.userId).toBe('user-a');
    const sent = Object.keys(init.headers).map((h) => h.toLowerCase());
    expect(sent.sort()).toEqual(['authorization', 'content-type']);
  });

  it.each([
    ['internal user sync', 'POST', ['internal', 'user-sync']],
    ['stripe webhook', 'POST', ['webhooks', 'stripe']],
    ['health', 'GET', ['health']],
    ['unknown controller', 'GET', ['admin']],
    ['mailbox link callback from the browser', 'POST', ['auth', 'mailbox', 'callback']],
    ['method not offered for the path', 'DELETE', ['inboxes', 'abc']],
    ['path traversal', 'GET', ['inboxes', '..', 'internal', 'user-sync']],
    ['encoded separator', 'GET', ['inboxes', 'a%2F..%2Finternal']],
    ['empty path', 'GET', []],
  ])('refuses a forbidden target: %s', async (_name, method, segments) => {
    const res = await proxyToBackend(
      request(segments.join('/'), { method, headers: { origin: ORIGIN } }),
      segments,
    );
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example' }],
    ['no origin at all', {}],
    ['a look-alike origin', { origin: 'https://app.example.test.evil.example' }],
  ])('refuses a cookie-authenticated mutation from %s', async (_name, headers) => {
    const res = await proxyToBackend(
      request('inboxes/pause', { method: 'POST', headers, body: '{}' }),
      ['inboxes', 'pause'],
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes a multipart upload through byte-for-byte with its boundary', async () => {
    const form = new FormData();
    form.append('file', new Blob(['email,provider\na@b.test,custom\n'], { type: 'text/csv' }), 'in.csv');
    const original = new Request(`${ORIGIN}/api/backend/inboxes/batch/csv`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: form,
    });
    const contentType = original.headers.get('content-type')!;
    const expectedBytes = Buffer.from(await original.clone().arrayBuffer());

    const res = await proxyToBackend(original, ['inboxes', 'batch', 'csv']);

    expect(res.status).toBe(200);
    const { init } = forwarded();
    expect(init.headers['content-type']).toBe(contentType);
    expect(contentType).toContain('boundary=');
    expect(Buffer.from(init.body as ArrayBuffer).equals(expectedBytes)).toBe(true);
  });

  it('refuses an oversized body before forwarding it', async () => {
    const res = await proxyToBackend(
      request('inboxes/batch', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      }),
      ['inboxes', 'batch'],
    );
    expect(res.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays the API’s status and body, and never follows an upstream redirect', async () => {
    upstream.mockResolvedValue(
      Response.json({ statusCode: 404, message: 'Not Found' }, { status: 404 }),
    );
    const res = await proxyToBackend(request('inboxes/someone-elses-id'), ['inboxes', 'someone-elses-id']);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, message: 'Not Found' });
    expect(forwarded().init.redirect).toBe('manual');
  });

  it('reports an unreachable API as a service failure, not as an empty result', async () => {
    upstream.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await proxyToBackend(request('inboxes'), ['inboxes']);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('ECONNREFUSED');
  });

  it('helpers: segment and origin rules', () => {
    expect(isSafeSegment('abc-123_x.y~')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a%2Fb', 'a b', 'a?b', 'a\\b']) {
      expect(isSafeSegment(bad)).toBe(false);
    }
    expect(isAllowedTarget('GET', ['inboxes', 'abc', 'score-history'])).toBe(true);
    expect(isAllowedTarget('DELETE', ['pool-inboxes', 'abc'])).toBe(true);
    expect(isAllowedTarget('GET', ['auth', 'gmail', 'connect'])).toBe(true);
    expect(isAllowedTarget('POST', ['auth', 'mailbox', 'callback'])).toBe(false);

    process.env.BETTER_AUTH_URL = 'https://www.example.test';
    expect(isSameOrigin(request('x', { headers: { origin: 'https://www.example.test' } }))).toBe(true);
    expect(isSameOrigin(request('x', { headers: { origin: 'http://www.example.test' } }))).toBe(false);
  });
});
