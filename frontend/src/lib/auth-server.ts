import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { Pool as PgPool } from 'pg';
import { syncUserToBackend } from './user-sync';

/**
 * Asks the API to send an account email through the platform mail account.
 * Failures are logged, not thrown, so the response to the browser is the
 * same whether or not an account exists or the mail went out.
 */
async function sendAuthEmail(message: { to: string; kind: 'password_reset'; url: string }) {
  const apiUrl = (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!apiUrl || !secret) {
    console.error('[auth] API_URL or INTERNAL_SECRET unset — cannot send account email');
    return;
  }
  try {
    const res = await fetch(`${apiUrl}/internal/auth-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error('[auth] account email was not sent', { status: res.status });
  } catch (err) {
    console.error('[auth] account email request failed', err);
  }
}

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
    // App-local role on the user. Citadel gates WHICH apps you can enter (the
    // grant); EmailWarm owns the fine-grained role. Default 'member'; founders
    // are seeded from FOUNDER_EMAILS and manage roles from the founder dashboard.
    user: {
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'member', input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      // The reset link works once, for 30 minutes, and choosing a new
      // password signs out every existing session. better-auth answers the
      // request the same way whether or not the address has an account.
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await sendAuthEmail({ to: user.email, kind: 'password_reset', url });
      },
    },
    rateLimit: {
      enabled: true,
      customRules: {
        '/request-password-reset': { window: 60 * 15, max: 3 },
        '/reset-password': { window: 60 * 15, max: 10 },
      },
    },
    // Login is delegated to Citadel (WebNCO ID) over OIDC. Google / Microsoft
    // are configured once in Citadel, not here. Mailbox-connect OAuth is a
    // separate concern and is untouched.
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'citadel',
            discoveryUrl: `${process.env.ZITADEL_ISSUER}/.well-known/openid-configuration`,
            clientId: process.env.ZITADEL_CLIENT_ID ?? '',
            clientSecret: process.env.ZITADEL_CLIENT_SECRET ?? '',
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        ],
      }),
    ],
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once a day
    },
    /**
     * Fires after better-auth writes a row to its `user` table. We use
     * it to mirror the user into the backend's `users` table (which
     * holds the plan/trial fields Stripe writes to) so the very first
     * authenticated request from a new user can find their row and
     * not 403 with "User not found". See T024.
     *
     * Fire-and-forget: errors are logged inside `syncUserToBackend` and
     * never thrown, so a transient backend hiccup can't break signup.
     */
    databaseHooks: {
      user: {
        create: {
          // Seed the role before insert: founders from FOUNDER_EMAILS, else member.
          before: async (user: { email?: string } & Record<string, unknown>) => {
            const founders = (process.env.FOUNDER_EMAILS ?? '')
              .split(',')
              .map((e) => e.trim().toLowerCase())
              .filter(Boolean);
            const role = founders.includes((user.email ?? '').toLowerCase()) ? 'founder' : 'member';
            return { data: { ...user, role } };
          },
          after: async (user: { id: string; email: string }) => {
            // Server-side call: must use the INTERNAL API URL (http://backend:4611),
            // not NEXT_PUBLIC_API_URL (the public https origin, which routes to
            // the Next app via Caddy and has no /internal/user-sync route → the
            // sync silently 404s and the backend users row is never created).
            const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '';
            const secret = process.env.INTERNAL_SECRET ?? '';
            // Intentionally not awaited — better-auth's hook contract
            // allows returning a promise but we don't want to block the
            // signup response on a cross-process HTTP call.
            void syncUserToBackend(
              { id: user.id, email: user.email },
              { apiUrl, secret },
            );
          },
        },
      },
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