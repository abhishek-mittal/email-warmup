import { callBackend, sessionUserId } from '@/lib/server/backend-proxy';

export const dynamic = 'force-dynamic';

/**
 * Where Google/Microsoft send the browser back after a mailbox-linking
 * consent screen. This is separate from account login, whose callback
 * better-auth owns under /api/auth/callback/*.
 *
 * The route only works for a signed-in user: the API binds the `state` to the
 * account that started the flow and checks it against the caller, so the
 * identity always comes from this session and never from the query string.
 * The browser is then sent to a fixed in-app page — never to a URL taken
 * from the request.
 */
const PROVIDERS = new Set(['google', 'microsoft']);
const KNOWN_ERROR_CODES = new Set([
  'denied',
  'state_invalid',
  'provider_error',
  'duplicate',
  'limit',
  'connection_failed',
]);

function redirectTo(req: Request, path: string): Response {
  const base = process.env.BETTER_AUTH_URL || process.env.APP_URL || new URL(req.url).origin;
  return Response.redirect(new URL(path, base), 303);
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (!PROVIDERS.has(provider)) {
    return redirectTo(req, '/inboxes/connect?link_error=provider_error');
  }

  const userId = await sessionUserId(req);
  if (!userId) {
    return redirectTo(req, '/sign-in?redirect_url=/inboxes/connect');
  }

  const query = new URL(req.url).searchParams;
  let response: Response;
  try {
    response = await callBackend(userId, '/auth/mailbox/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider,
        code: query.get('code') ?? undefined,
        state: query.get('state') ?? undefined,
        error: query.get('error') ?? undefined,
      }),
    });
  } catch {
    return redirectTo(req, '/inboxes/connect?link_error=provider_error');
  }

  if (response.ok) {
    return redirectTo(req, '/inboxes?connected=1');
  }

  let code = 'provider_error';
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === 'string' && KNOWN_ERROR_CODES.has(body.code)) code = body.code;
  } catch {
    // keep the generic code
  }
  return redirectTo(req, `/inboxes/connect?link_error=${code}`);
}
