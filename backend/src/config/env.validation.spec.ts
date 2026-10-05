import 'reflect-metadata';
import { validate } from './env.validation';

/**
 * MR-11: the encryption key must be validated at boot. A key that is not
 * exactly 32 bytes (64 hex characters) must fail process startup rather than
 * throwing lazily on the first encrypt/decrypt call.
 */
const VALID_HEX_KEY = 'a'.repeat(64);

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: VALID_HEX_KEY,
    BETTER_AUTH_SECRET: 'better-auth-secret-value',
    INTERNAL_SECRET: 'internal-secret-16chars',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: 'ms-id',
    MICROSOFT_CLIENT_SECRET: 'ms-secret',
    APP_URL: 'http://localhost:3000',
    PLATFORM_SMTP_HOST: 'smtp.example.com',
    PLATFORM_SMTP_PORT: '587',
    PLATFORM_SMTP_USER: 'user',
    PLATFORM_SMTP_PASS: 'pass',
    PLATFORM_FROM_EMAIL: 'from@example.com',
    // Demo mode keeps Stripe variables optional for this test.
    DEMO_MODE: 'true',
    ...overrides,
  };
}

describe('env validation — ENCRYPTION_KEY', () => {
  // stripeRequired() reads process.env.DEMO_MODE directly (not the config
  // object), so Stripe vars are only optional when the real env says so.
  const prevDemoMode = process.env.DEMO_MODE;
  beforeAll(() => {
    process.env.DEMO_MODE = 'true';
  });
  afterAll(() => {
    if (prevDemoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prevDemoMode;
  });

  it('accepts a 64-hex-character key', () => {
    expect(() => validate(baseEnv())).not.toThrow();
  });

  it('rejects a key shorter than 64 hex characters', () => {
    expect(() => validate(baseEnv({ ENCRYPTION_KEY: 'abc123' }))).toThrow(
      /ENCRYPTION_KEY must be 32 bytes/,
    );
  });

  it('rejects a 64-character key that is not hex', () => {
    expect(() => validate(baseEnv({ ENCRYPTION_KEY: 'z'.repeat(64) }))).toThrow(
      /ENCRYPTION_KEY must be 32 bytes/,
    );
  });

  it('rejects a key with the wrong byte length (32 hex chars = 16 bytes)', () => {
    expect(() => validate(baseEnv({ ENCRYPTION_KEY: 'a'.repeat(32) }))).toThrow(
      /ENCRYPTION_KEY must be 32 bytes/,
    );
  });
});
