import { betterAuth } from 'better-auth';
import { Pool as PgPool } from 'pg';

let _pool: PgPool | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any;

function getPool(): PgPool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for better-auth');
  }
  _pool = new PgPool({ connectionString: url });
  return _pool;
}

/**
 * Server-side better-auth instance. Used by:
 *   - the catch-all route handler at /api/auth/[...all]
 *   - server components that need to read the current session
 *   - the bearer-token mint helper (to embed userId in the Authorization header)
 *
 * Tables (`user`, `session`, `account`, `verification`) are created lazily by
 * better-auth on first request if they don't exist.
 */
function makeAuth() {
  return betterAuth({
    database: getPool(),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      },
      microsoft: {
        clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once a day
    },
  });
}

/** Lazy singleton — the underlying pool is only opened on first use so
 *  that build-time page-data collection (which has no env vars) doesn't
 *  fail to import this module. */
export function getAuth() {
  if (!_auth) _auth = makeAuth();
  return _auth;
}

// Convenience export for the common case.
export const auth = new Proxy({} as ReturnType<typeof betterAuth>, {
  get(_target, prop) {
    return (getAuth() as ReturnType<typeof betterAuth>)[prop as keyof ReturnType<typeof betterAuth>];
  },
});