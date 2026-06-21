import { getAuth } from '@/lib/auth-server';
import { toNextJsHandler } from 'better-auth/next-js';

/**
 * Catch-all route for the better-auth HTTP API (sign-in, sign-up, OAuth
 * callbacks, session refresh, etc.). The handler is built from the same
 * `getAuth()` instance used by `lib/auth-server.ts` so cookies + database
 * stay in one process.
 */
export const { GET, POST } = toNextJsHandler(getAuth() as unknown as { handler: (r: Request) => Promise<Response> });