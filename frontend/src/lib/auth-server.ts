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

/**
 * Lazy singleton — the underlying pool is only opened on first use so
 * that build-time page-data collection (which has no env vars) doesn't
 * fail to import this module.
 *
 * On first construction we also run better-auth's migrations
 * idempotently to ensure its `user`/`session`/`account`/`verification`
 * tables exist. better-auth normally does this lazily on first request,
 * but with our pg.Pool setup the auto-migration can race with the first
 * signup and 500. We make the bootstrap explicit so the seed script
 * (and any other cold-start caller) gets a clean schema.
 */
let _migrated = false;
let _migrationPromise: Promise<void> | undefined;
export function getAuth(): ReturnType<typeof betterAuth> {
  if (!_auth) {
    _auth = makeAuth();
    if (!_migrated) {
      _migrated = true;
      // In better-auth 1.6.x, `$context` is a Promise (it's the awaitable
      // returned by `init()`), not the resolved context object. The actual
      // context (with `runMigrations` attached) is the resolved value.
      // Run synchronously and return the in-flight promise so the first
      // signup request awaits the migration before it touches the DB.
      const ctxPromise = (
        _auth as unknown as {
          $context: Promise<{ runMigrations?: () => Promise<void> }>;
        }
      ).$context;
      _migrationPromise = ctxPromise
        .then((ctx) => ctx.runMigrations?.())
        .catch((err: unknown) => {
          console.error('[better-auth] runMigrations failed:', err);
        });
    }
  }
  return _auth;
}

/**
 * Awaitable hook for callers (the catch-all route handler, the seed
 * script) that need to be sure the schema exists before they touch it.
 */
export async function waitForAuthSchema(): Promise<void> {
  getAuth();
  if (_migrationPromise) await _migrationPromise;
}