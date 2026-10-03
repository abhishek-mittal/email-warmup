import { getAuth, waitForAuthSchema } from '@/lib/auth-server';
import { toNextJsHandler } from 'better-auth/next-js';

/**
 * Catch-all route for the better-auth HTTP API (sign-in, sign-up, OAuth
 * callbacks, session refresh, etc.). The handler is built from the same
 * `getAuth()` instance used by `lib/auth-server.ts` so cookies + database
 * stay in one process.
 *
 * The exported handlers also `await waitForAuthSchema()` so the very first
 * sign-up request after a cold start never races against the schema
 * migration. Once the migration is done the promise resolves instantly and
 * there's no per-request overhead.
 */
type Handlers = ReturnType<typeof toNextJsHandler>;
let handlers: Handlers | undefined;

/**
 * Built on first request, not at import: the build collects page data by
 * importing this module, with no database or secrets available.
 */
function getHandlers(): Handlers {
  if (!handlers) {
    handlers = toNextJsHandler(
      getAuth() as unknown as { handler: (r: Request) => Promise<Response> },
    );
  }
  return handlers;
}

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  await waitForAuthSchema();
  return getHandlers().GET(req);
}

export async function POST(req: Request) {
  await waitForAuthSchema();
  return getHandlers().POST(req);
}
