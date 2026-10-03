// Points the app at the disposable services from ../../docker-compose.test.yml.
// Start them with: docker compose -f docker-compose.test.yml up -d
// These values are fixtures for local/CI use only — never real credentials.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://emailwarm:localtest@127.0.0.1:55432/emailwarm_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:56379/1';
process.env.ENCRYPTION_KEY = '11'.repeat(32);
process.env.BETTER_AUTH_SECRET = 'integration-test-better-auth-secret-32-chars-min';
process.env.INTERNAL_SECRET = 'integration-test-internal-secret';
process.env.ANTHROPIC_API_KEY = 'sk-ant-not-used-in-tests';
// GreenMail speaks plaintext SMTP/IMAP on loopback.
process.env.MAIL_ALLOW_INSECURE_TRANSPORT = 'true';
process.env.TEST_SMTP_HOST = process.env.TEST_SMTP_HOST || '127.0.0.1';
process.env.TEST_SMTP_PORT = process.env.TEST_SMTP_PORT || '53025';
process.env.TEST_IMAP_HOST = process.env.TEST_IMAP_HOST || '127.0.0.1';
process.env.TEST_IMAP_PORT = process.env.TEST_IMAP_PORT || '53143';
// GreenMail is on loopback, which the egress policy refuses by default.
process.env.MAIL_EGRESS_ALLOWLIST = '127.0.0.1';
